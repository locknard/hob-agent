import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  ProposalStoreError,
  SqliteProposalStore,
  type CreateProposalInput,
} from "./proposal-store.js";

const createdAt = "2026-08-19T01:00:00.000Z";

function input(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    kind: "automation-draft",
    title: "Turn off a light after an inactive period",
    summary: "A review-only draft based on bounded household evidence.",
    idempotencyKey: "automation-draft:light:inactive:v1",
    provenance: {
      producer: "dsh-home-agent",
      sessionId: "home-main",
      turnId: "turn-7",
    },
    evidence: {
      references: [{
        bridgeId: "ha-main",
        hwId: "hw-7",
        capabilityId: "hwc-4",
        observedAt: "2026-08-19T00:59:00.000Z",
      }],
      watermarks: [{
        bridgeId: "ha-main",
        epochId: "epoch-3",
        lastSeq: 606,
        freshness: "fresh",
        gapCount: 0,
      }],
    },
    conflictCheck: {
      status: "checked",
      existingAutomationCount: 15,
      matches: [{ identity: "automation-aggregate", relation: "possible_overlap" }],
    },
    dryRun: { status: "passed", summary: "No device or automation was changed." },
    risk: {
      level: "medium",
      reasons: ["May affect an occupied area"],
      requiresHumanApproval: true,
    },
    intent: {
      type: "automation-draft",
      description: "Create a draft rule; do not install it.",
      rollback: "Discard the draft proposal.",
    },
    ...overrides,
  };
}

test("persists a bounded pending proposal and append-only creation audit across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposals-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt });

  const proposal = store.create(input());
  assert.equal(proposal.status, "pending_review");
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.createdAt, createdAt);
  assert.equal(proposal.risk.requiresHumanApproval, true);
  assert.equal(proposal.audit[0]?.action, "created");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  store.close();

  const reopened = new SqliteProposalStore({ path });
  assert.deepEqual(reopened.get(proposal.id), proposal);
  assert.deepEqual(reopened.list({ status: "pending_review" }), [proposal]);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("deduplicates a producer idempotency key without adding another audit event", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });

  const first = store.create(input());
  const repeated = store.create(input({ title: "A model phrased this differently" }));

  assert.deepEqual(repeated, first);
  assert.equal(store.list().length, 1);
  assert.equal(repeated.audit.length, 1);
  store.close();
});

test("reviews with optimistic concurrency and never treats approval as application", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  const proposal = store.create(input());
  now = "2026-08-19T01:05:00.000Z";

  const approved = store.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    note: "Safe to prepare as an artifact later.",
  });

  assert.equal(approved.status, "approved");
  assert.equal(approved.revision, 2);
  assert.equal(approved.applicationStatus, "not_available");
  assert.equal(approved.review?.reviewer, "household-owner");
  assert.deepEqual(approved.audit.map((event) => event.action), ["created", "approved"]);
  assert.throws(
    () => store.review({
      proposalId: proposal.id,
      expectedRevision: 1,
      decision: "rejected",
      reviewer: "stale-reviewer",
    }),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "revision_conflict",
  );
  assert.throws(
    () => store.review({
      proposalId: proposal.id,
      expectedRevision: 2,
      decision: "rejected",
      reviewer: "second-reviewer",
    }),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "terminal_status",
  );
  store.close();
});

test("rejects missing conflict checks, unsafe approval semantics, and oversized text", () => {
  const store = new SqliteProposalStore({ path: ":memory:" });

  assert.throws(
    () => store.create(input({ conflictCheck: { status: "unavailable", existingAutomationCount: 0, matches: [] } })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "conflict_check_required",
  );
  assert.throws(
    () => store.create(input({ risk: { level: "low", reasons: [], requiresHumanApproval: false } })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "human_approval_required",
  );
  assert.throws(
    () => store.create(input({ title: "x".repeat(121) })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  assert.throws(
    () => store.create(input({
      evidence: {
        references: [{
          bridgeId: "bridge-a",
          observedAt: createdAt,
          source: "post-baseline-event",
          epochId: "model-authored-epoch",
        }],
        watermarks: [{
          bridgeId: "bridge-a",
          epochId: "epoch-a",
          lastSeq: 1,
          freshness: "fresh",
          gapCount: 0,
        }],
      },
    })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  store.close();
});

test("fails closed when persisted proposal state is corrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposals-corrupt-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt });
  const proposal = store.create(input());
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE proposals SET payload_json = ? WHERE proposal_id = ?")
    .run(JSON.stringify({ id: proposal.id, status: "applied" }), proposal.id);
  raw.close();

  const reopened = new SqliteProposalStore({ path });
  assert.throws(
    () => reopened.get(proposal.id),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "corrupt_store",
  );
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});
