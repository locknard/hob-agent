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
    rationale: {
      householdValue: "Reduce unnecessary lighting.",
      whyNow: "Recent bounded evidence suggests a review is timely.",
      uncertainties: ["Whether the current timing reflects household preference."],
    },
    spaceCoverage: {
      selectedDevices: 1,
      devicesWithSingleSpace: 0,
      devicesWithoutSpace: 1,
      devicesWithMultipleSpaces: 0,
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

test("rejects an asynchronous retention evidence callback before committing", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    assert.throws(
      () => store.withRetentionEvidence("ha-main", 1_000, async () => {
        await Promise.resolve();
      }),
      (error: unknown) => error instanceof TypeError && error.message === "Retention evidence callback must be synchronous",
    );
  } finally {
    store.close();
  }
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
    feedbackCode: "useful_as_is",
    note: "Safe to prepare as an artifact later.",
  });

  assert.equal(approved.status, "approved");
  assert.equal(approved.revision, 2);
  assert.equal(approved.applicationStatus, "not_available");
  assert.equal(approved.review?.reviewer, "household-owner");
  assert.equal(approved.review?.feedbackCode, "useful_as_is");
  assert.equal(approved.audit.at(-1)?.feedbackCode, "useful_as_is");
  assert.deepEqual(approved.audit.map((event) => event.action), ["created", "approved"]);
  assert.throws(
    () => store.review({
      proposalId: proposal.id,
      expectedRevision: 1,
      decision: "rejected",
      reviewer: "stale-reviewer",
      feedbackCode: "already_covered",
    }),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "revision_conflict",
  );
  assert.throws(
    () => store.review({
      proposalId: proposal.id,
      expectedRevision: 2,
      decision: "rejected",
      reviewer: "second-reviewer",
      feedbackCode: "not_useful",
    }),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "terminal_status",
  );
  store.close();
});

test("summarizes proposal quality without returning household content", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  const approved = store.create(input({ idempotencyKey: "quality:approved" }));
  store.review({
    proposalId: approved.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  const rejected = store.create(input({ idempotencyKey: "quality:rejected" }));
  store.review({
    proposalId: rejected.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "incorrect_assumption",
  });
  store.create(input({ idempotencyKey: "quality:pending" }));

  const summary = store.qualitySummary();
  assert.deepEqual(summary, {
    total: 3,
    statuses: { pending_review: 1, approved: 1, rejected: 1, expired: 0 },
    feedback: {
      useful_as_is: 1,
      already_covered: 0,
      not_useful: 0,
      incorrect_assumption: 1,
      insufficient_evidence: 0,
      household_preference: 0,
      too_risky: 0,
      other: 0,
    },
    reviewedWithoutFeedback: 0,
  });
  assert.equal(JSON.stringify(summary).includes("Turn off a light"), false);
  store.close();
});

test("projects recent structured calibration without reviewer identity or notes", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  const approved = store.create(input({ idempotencyKey: "calibration:approved" }));
  now = "2026-08-19T01:01:00.000Z";
  store.review({
    proposalId: approved.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "private-reviewer",
    feedbackCode: "useful_as_is",
    note: "private household detail",
  });
  now = "2026-08-19T01:02:00.000Z";
  store.create(input({ idempotencyKey: "calibration:pending", title: "Pending topic" }));

  const history = store.calibrationHistory(1);
  assert.deepEqual(history, [{
    proposalId: approved.id,
    kind: "automation-draft",
    title: "Turn off a light after an inactive period",
    decision: "approved",
    reviewedAt: "2026-08-19T01:01:00.000Z",
    feedbackCode: "useful_as_is",
  }]);
  assert.equal(JSON.stringify(history).includes("private-reviewer"), false);
  assert.equal(JSON.stringify(history).includes("private household detail"), false);
  assert.equal(JSON.stringify(history).includes("Pending topic"), false);
  assert.throws(() => store.calibrationHistory(21), /limit/);
  store.close();
});

test("requires bounded decision-specific feedback for new household reviews", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });

  const missing = store.create(input({ idempotencyKey: "feedback:missing" }));
  assert.throws(() => store.review({
    proposalId: missing.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
  }), /feedback/i);

  const wrongDecision = store.create(input({ idempotencyKey: "feedback:wrong-decision" }));
  assert.throws(() => store.review({
    proposalId: wrongDecision.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "too_risky",
  }), /feedback/i);

  const unexplainedOther = store.create(input({ idempotencyKey: "feedback:other" }));
  assert.throws(() => store.review({
    proposalId: unexplainedOther.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "other",
  }), /note/i);

  const rejected = store.create(input({ idempotencyKey: "feedback:preference" }));
  const reviewed = store.review({
    proposalId: rejected.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "household_preference",
  });
  assert.equal(reviewed.review?.feedbackCode, "household_preference");
  assert.equal(reviewed.audit.at(-1)?.feedbackCode, "household_preference");
  store.close();
});

test("keeps reviewed v1 rows from before structured feedback readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-feedback-compat-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt, id: () => "legacy-id" });
  const proposal = store.create(input());
  store.close();

  const reviewedAt = "2026-08-19T01:10:00.000Z";
  const {
    rationale: _newRationale,
    spaceCoverage: _newSpaceCoverage,
    ...legacyProposal
  } = proposal;
  const legacyReviewed = {
    ...legacyProposal,
    revision: 2,
    status: "approved",
    updatedAt: reviewedAt,
    review: {
      decision: "approved",
      reviewer: "household-owner",
      reviewedAt,
    },
    audit: [...proposal.audit, {
      id: "audit-legacy-review",
      at: reviewedAt,
      action: "approved",
      actor: "household-owner",
      revision: 2,
    }],
  };
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE proposals SET status = ?, revision = ?, updated_at = ?, payload_json = ? WHERE proposal_id = ?")
    .run("approved", 2, reviewedAt, JSON.stringify(legacyReviewed), proposal.id);
  raw.close();

  const reopened = new SqliteProposalStore({ path });
  const loaded = reopened.get(proposal.id);
  assert.equal(loaded?.status, "approved");
  assert.equal(loaded?.review?.feedbackCode, undefined);
  assert.equal(loaded?.spaceCoverage, undefined);
  assert.equal(reopened.qualitySummary().reviewedWithoutFeedback, 1);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("fails closed when persisted review feedback disagrees with its audit event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-feedback-corrupt-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt });
  const proposal = store.create(input());
  const approved = store.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  store.close();

  const corrupt = {
    ...approved,
    audit: approved.audit.map((event, index) =>
      index === approved.audit.length - 1 ? { ...event, feedbackCode: "too_risky" } : event),
  };
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE proposals SET payload_json = ? WHERE proposal_id = ?")
    .run(JSON.stringify(corrupt), proposal.id);
  raw.close();

  const reopened = new SqliteProposalStore({ path });
  assert.throws(
    () => reopened.get(proposal.id),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "corrupt_store",
  );
  reopened.close();
  await rm(directory, { recursive: true, force: true });
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
    () => store.create(input({ idempotencyKey: "missing-rationale", rationale: undefined })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  assert.throws(
    () => store.create(input({ idempotencyKey: "missing-space-coverage", spaceCoverage: undefined })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  assert.throws(
    () => store.create(input({
      idempotencyKey: "invalid-space-coverage-sum",
      spaceCoverage: {
        selectedDevices: 1,
        devicesWithSingleSpace: 1,
        devicesWithoutSpace: 1,
        devicesWithMultipleSpaces: 0,
      },
    })),
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
