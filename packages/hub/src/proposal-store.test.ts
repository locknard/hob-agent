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

const artifactCandidate = {
  schemaVersion: "1" as const,
  content: {
    trigger: { kind: "capability_changed" as const, source: { hwCapabilityId: "hwc-4" } },
    conditions: [],
    actions: [{ kind: "set_boolean" as const, target: { hwCapabilityId: "hwc-4" }, value: false }],
    rollback: { kind: "restore_previous_state" as const, target: { hwCapabilityId: "hwc-4" }, maxAgeSeconds: 3_600 },
    postconditions: [{
      kind: "capability_value" as const,
      source: { hwCapabilityId: "hwc-4" },
      operator: "equals" as const,
      value: false,
      withinSeconds: 30,
    }],
  },
};

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

test("persists a strict review-only artifact candidate without treating it as an artifact", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  const proposal = store.create(input({ artifactCandidate }));
  assert.deepEqual(proposal.artifactCandidate, artifactCandidate);
  assert.equal("artifactId" in proposal.artifactCandidate!, false);
  assert.equal("contentHash" in proposal.artifactCandidate!, false);
  assert.throws(
    () => store.create(input({ artifactCandidate: { ...artifactCandidate, contentHash: "forged" } as never })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  assert.throws(
    () => store.create(input({
      kind: "household-insight",
      idempotencyKey: "candidate-on-insight:v1",
      artifactCandidate,
    })),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "invalid_proposal",
  );
  store.close();
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

test("returns capacity_full without persisting or later admitting a sixth proposal", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  try {
    const proposals = Array.from({ length: 5 }, (_, index) => store.create(input({
      dedupKey: `capacity-behavior:${index}`,
      idempotencyKey: `capacity-idempotency:${index}`,
    })));
    const snoozed = store.snoozeProposal({
      proposalId: proposals[0]!.id,
      expectedRevision: proposals[0]!.revision,
      until: "tomorrow",
    });
    assert.equal(snoozed.status, "pending_review");
    assert.equal(snoozed.snoozeCount, 1);
    assert.ok(snoozed.snoozedUntil);
    assert.equal(store.proposalCapacity().used, 5);
    const full = store.createGoverned(input({
      dedupKey: "capacity-overflow",
      idempotencyKey: "capacity-overflow-idempotency",
    }));
    assert.deepEqual(full, { kind: "capacity_full" });
    assert.equal(store.list({ status: "pending_review" }).length, 5);

    now = snoozed.snoozedUntil!;
    const reopened = store.get(snoozed.id);
    assert.equal(reopened?.status, "pending_review");
    assert.equal(reopened?.snoozedUntil, undefined);
    assert.equal(reopened?.snoozeCount, 1);
    assert.equal(reopened?.revision, snoozed.revision + 1);

    const rejected = store.review({
      proposalId: proposals[1]!.id,
      expectedRevision: proposals[1]!.revision,
      decision: "rejected",
      reviewer: "household-owner",
      feedbackCode: "not_useful",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(store.list({ status: "pending_review" }).length, 4);
    assert.equal(store.list({ status: "pending_review" }).some((proposal) => proposal.dedupKey === "capacity-overflow"), false);
  } finally {
    store.close();
  }
});

test("merges new evidence into an existing behavior identity while capacity is full", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const target = store.create(input({
      dedupKey: "capacity-merge",
      idempotencyKey: "capacity-merge:v1",
    }));
    for (let index = 1; index < 5; index += 1) {
      store.create(input({
        dedupKey: `capacity-merge:${index}`,
        idempotencyKey: `capacity-merge:${index}:v1`,
      }));
    }
    const secondReference = {
      bridgeId: "ha-main",
      hwId: "hw-7",
      capabilityId: "hwc-4",
      observedAt: "2026-08-19T01:00:00.000Z",
    } as const;
    const merged = store.createGoverned(input({
      dedupKey: "capacity-merge",
      idempotencyKey: "capacity-merge:v2",
      evidence: {
        ...input().evidence,
        references: [secondReference],
      },
    }));
    assert.equal(merged.kind, "merged");
    if (merged.kind !== "merged") throw new Error("expected evidence merge");
    assert.equal(merged.proposal.id, target.id);
    assert.equal(merged.mergedEvidenceCount, 1);
    assert.equal(merged.proposal.evidence.references.length, 2);
    assert.equal(store.list({ status: "pending_review" }).length, 5);
  } finally {
    store.close();
  }
});

test("keeps a dedup latch suppressing a proposal while review capacity is full", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const latched = store.create(input({
      dedupKey: "latched-at-capacity",
      idempotencyKey: "latched-at-capacity:v1",
    }));
    const decision = store.decideProposal({
      proposalId: latched.id,
      expectedRevision: latched.revision,
      decision: "do_not_suggest",
      reviewer: "household-owner",
    });
    assert.equal(decision.status, "rejected");
    for (let index = 0; index < 5; index += 1) {
      store.create(input({
        dedupKey: `latched-capacity:${index}`,
        idempotencyKey: `latched-capacity:${index}:v1`,
      }));
    }
    const suppressed = store.createGoverned(input({
      dedupKey: "latched-at-capacity",
      idempotencyKey: "latched-at-capacity:v2",
    }));
    assert.deepEqual(suppressed, {
      kind: "suppressed",
      reason: "dedup_latched",
      dedupKey: "latched-at-capacity",
    });
    assert.equal(store.list({ status: "pending_review" }).length, 5);
  } finally {
    store.close();
  }
});

test("does not admit a capacity rejection after a store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-capacity-"));
  const path = join(directory, "proposals.sqlite");
  const firstStore = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    const full = Array.from({ length: 5 }, (_, index) => firstStore.create(input({
      dedupKey: `restart-capacity:${index}`,
      idempotencyKey: `restart-capacity:${index}`,
    })));
    assert.deepEqual(firstStore.createGoverned(input({
      dedupKey: "restart-overflow",
      idempotencyKey: "restart-overflow:v1",
    })), { kind: "capacity_full" });
    firstStore.review({
      proposalId: full[0]!.id,
      expectedRevision: full[0]!.revision,
      decision: "rejected",
      reviewer: "household-owner",
      feedbackCode: "not_useful",
    });
  } finally {
    firstStore.close();
  }
  const reopened = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    assert.equal(reopened.list({ status: "pending_review" }).some((proposal) => proposal.dedupKey === "restart-overflow"), false);
    assert.equal(reopened.list({ status: "pending_review" }).length, 4);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows exactly two snoozes and exposes the three bounded targets", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  try {
    const proposal = store.create(input({ dedupKey: "snooze-behavior", idempotencyKey: "snooze-1" }));
    const first = store.snoozeProposal({ proposalId: proposal.id, expectedRevision: proposal.revision, until: "weekend" });
    const second = store.snoozeProposal({ proposalId: first.id, expectedRevision: first.revision, until: "next_week" });
    assert.equal(second.snoozeCount, 2);
    assert.throws(
      () => store.snoozeProposal({ proposalId: second.id, expectedRevision: second.revision, until: "tomorrow" }),
      /snooze/i,
    );
    assert.throws(
      () => store.snoozeProposal({ proposalId: second.id, expectedRevision: second.revision, until: "invalid" as never }),
      /snooze/i,
    );
  } finally {
    store.close();
  }
});

test("reject_once closes only the current proposal while do_not_suggest atomically latches its stable behavior identity", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const once = store.create(input({ dedupKey: "same-light-behavior", idempotencyKey: "reject-once-1" }));
    const rejectedOnce = store.decideProposal({
      proposalId: once.id,
      expectedRevision: once.revision,
      decision: "reject_once",
      reviewer: "household-owner",
    });
    assert.equal(rejectedOnce.status, "rejected");
    assert.equal(rejectedOnce.decision?.kind, "reject_once");
    assert.deepEqual(store.listDedupLatches(), []);

    const replacement = store.create(input({ dedupKey: "same-light-behavior", idempotencyKey: "reject-once-2" }));
    assert.notEqual(replacement.id, once.id);
    const latched = store.decideProposal({
      proposalId: replacement.id,
      expectedRevision: replacement.revision,
      decision: "do_not_suggest",
      reviewer: "household-owner",
    });
    assert.equal(latched.status, "rejected");
    assert.equal(latched.decision?.kind, "do_not_suggest");
    assert.deepEqual(store.listDedupLatches().map((item) => item.dedupKey), ["same-light-behavior"]);
    assert.throws(
      () => store.create(input({ dedupKey: "same-light-behavior", idempotencyKey: "reject-once-3" })),
      (error: unknown) => error instanceof ProposalStoreError && error.code === "dedup_latched",
    );
  } finally {
    store.close();
  }
});

test("clears a do-not-suggest latch only through an explicit audited governance command", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const proposal = store.create(input({ dedupKey: "clearable-behavior", idempotencyKey: "clearable-1" }));
    store.decideProposal({
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "do_not_suggest",
      reviewer: "household-owner",
    });
    assert.equal(store.hasDedupLatch("clearable-behavior"), true);
    const cleared = store.clearDedupLatch({
      dedupKey: "clearable-behavior",
      reviewer: "household-owner",
      note: "The household wants to reconsider this behavior.",
    });
    assert.equal(cleared.action, "cleared");
    assert.equal(cleared.actor, "household-owner");
    assert.equal(store.hasDedupLatch("clearable-behavior"), false);
    assert.equal(store.listDedupLatchAudit().at(-1)?.action, "cleared");
    assert.equal(store.create(input({ dedupKey: "clearable-behavior", idempotencyKey: "clearable-2" })).status, "pending_review");
  } finally {
    store.close();
  }
});

test("requires a completed seven-day trial and a second explicit approval before enablement", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  try {
    const proposal = store.create(input({ dedupKey: "two-thumbs", idempotencyKey: "two-thumbs-1" }));
    const direction = store.review({
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });
    assert.equal(direction.rolloutState, "trial_active");
    assert.equal(direction.trial?.durationDays, 7);
    assert.equal(direction.applicationStatus, "not_available");
    assert.throws(() => store.enableProposal({
      proposalId: direction.id,
      expectedRevision: direction.revision,
      reviewer: "household-owner",
    }), /trial/i);

    now = direction.trial!.endsAt;
    const ready = store.advanceProposalTrial({
      proposalId: direction.id,
      expectedRevision: direction.revision,
    });
    assert.equal(ready.rolloutState, "enable_pending");
    const enabled = store.enableProposal({
      proposalId: ready.id,
      expectedRevision: ready.revision,
      reviewer: "household-owner",
      note: "The seven-day trial met the household criteria.",
    });
    assert.equal(enabled.rolloutState, "enabled");
    assert.equal(enabled.applicationStatus, "not_available");
    assert.deepEqual(enabled.audit.map((event) => event.action), [
      "created",
      "approved",
      "trial_completed",
      "enabled",
    ]);
  } finally {
    store.close();
  }
});

test("merges new evidence for an unresolved behavior without creating a second proposal", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const first = store.create(input({
      dedupKey: "evidence-behavior",
      idempotencyKey: "evidence-1",
      evidence: {
        ...input().evidence,
        references: [{
          bridgeId: "ha-main",
          hwId: "hw-7",
          capabilityId: "hwc-4",
          observedAt: "2026-08-19T00:59:00.000Z",
          source: "current-state",
        }],
      },
    }));
    const merged = store.create(input({
      dedupKey: "evidence-behavior",
      idempotencyKey: "evidence-2",
      title: "A refreshed wording must not replace the reviewed card",
      evidence: {
        ...input().evidence,
        references: [{
          bridgeId: "ha-main",
          hwId: "hw-7",
          capabilityId: "hwc-4",
          observedAt: "2026-08-19T01:00:00.000Z",
          source: "current-state",
        }],
      },
    }));
    assert.equal(merged.id, first.id);
    assert.equal(merged.revision, first.revision + 1);
    assert.equal(merged.title, first.title);
    assert.equal(merged.newEvidence, true);
    assert.equal(merged.evidence.references.length, 2);
    assert.equal(merged.audit.at(-1)?.action, "evidence_merged");
    assert.deepEqual(store.create(input({
      dedupKey: "evidence-behavior",
      idempotencyKey: "evidence-2",
    })), merged);
  } finally {
    store.close();
  }
});

test("naturally expires after fourteen days, preserves the audit, and permits a fresh proposal for the behavior", async () => {
  let now = createdAt;
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-governance-expiry-"));
  const path = join(directory, "proposals.sqlite");
  const firstStore = new SqliteProposalStore({ path, now: () => now });
  const first = firstStore.create(input({ dedupKey: "expiry-behavior", idempotencyKey: "expiry-1" }));
  firstStore.close();

  now = "2026-09-02T01:00:00.000Z";
  const reopened = new SqliteProposalStore({ path, now: () => now });
  try {
    const expired = reopened.get(first.id);
    assert.equal(expired?.status, "expired");
    assert.equal(expired?.review?.decision, "expired");
    assert.equal(expired?.audit.at(-1)?.action, "expired");
    const replacement = reopened.create(input({ dedupKey: "expiry-behavior", idempotencyKey: "expiry-2" }));
    assert.notEqual(replacement.id, first.id);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes same-behavior creation across two SQLite connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-governance-concurrent-"));
  const path = join(directory, "proposals.sqlite");
  const firstStore = new SqliteProposalStore({ path, now: () => createdAt });
  const secondStore = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    const first = firstStore.create(input({ dedupKey: "concurrent-behavior", idempotencyKey: "concurrent-1" }));
    const second = secondStore.create(input({ dedupKey: "concurrent-behavior", idempotencyKey: "concurrent-2" }));
    assert.equal(second.id, first.id);
    assert.equal(firstStore.list().length, 1);
    assert.equal(secondStore.get(first.id)?.evidence.references.length, first.evidence.references.length);
  } finally {
    firstStore.close();
    secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
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
  const proposal = store.create(input({ artifactCandidate }));
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

test("projects a deeply frozen Hub-verified source only for the current approved automation revision", () => {
  let now = createdAt;
  const store = new SqliteProposalStore({ path: ":memory:", now: () => now });
  const proposal = store.create(input({ artifactCandidate }));
  now = "2026-08-19T01:05:00.000Z";
  const approved = store.review({
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });

  const source = store.withApprovedProposalAtRevision(approved.id, approved.revision, (value) => {
    assert.equal(value.proposalId, approved.id);
    assert.equal(value.revision, 2);
    assert.equal(value.kind, "automation-draft");
    assert.equal(value.status, "approved");
    assert.equal(value.applicationStatus, "not_available");
    assert.equal(value.title, approved.title);
    assert.equal(value.summary, approved.summary);
    assert.deepEqual(value.intent, approved.intent);
    assert.deepEqual(value.evidence, approved.evidence);
    assert.deepEqual(value.conflictCheck, approved.conflictCheck);
    assert.deepEqual(value.risk, approved.risk);
    assert.deepEqual(value.artifactCandidate, artifactCandidate);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.evidence), true);
    assert.equal(Object.isFrozen(value.evidence.references), true);
    assert.throws(() => {
      (value as unknown as { title: string }).title = "caller mutation";
    }, TypeError);
    assert.throws(() => {
      (value.evidence.references as unknown as Array<unknown>).push({});
    }, TypeError);
    return value;
  });
  assert.equal(source.proposalId, approved.id);
  store.close();
});

test("fails closed for missing, non-current, pending, and non-approved source revisions", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  const pending = store.create(input({ idempotencyKey: "source-pending", artifactCandidate }));
  assert.throws(
    () => store.withApprovedProposalAtRevision(pending.id, pending.revision, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "source_unavailable",
  );
  assert.throws(
    () => store.withApprovedProposalAtRevision("proposal-missing", 2, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "not_found",
  );

  const approved = store.review({
    proposalId: pending.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  assert.throws(
    () => store.withApprovedProposalAtRevision(approved.id, 1, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "revision_conflict",
  );

  const rejected = store.create(input({ idempotencyKey: "source-rejected" }));
  const rejectedRevision = store.review({
    proposalId: rejected.id,
    expectedRevision: 1,
    decision: "rejected",
    reviewer: "household-owner",
    feedbackCode: "not_useful",
  });
  assert.throws(
    () => store.withApprovedProposalAtRevision(rejectedRevision.id, rejectedRevision.revision, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "source_unavailable",
  );
  const legacy = store.create(input({ idempotencyKey: "source-legacy-without-candidate" }));
  const legacyApproved = store.review({
    proposalId: legacy.id,
    expectedRevision: 1,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  assert.throws(
    () => store.withApprovedProposalAtRevision(legacyApproved.id, legacyApproved.revision, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "source_unavailable",
  );
  store.close();
});

test("cross-checks SQL proposal metadata and the complete approved audit chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-source-integrity-"));
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

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE proposals SET status = ? WHERE proposal_id = ?")
    .run("pending_review", approved.id);
  raw.close();
  const metadataCorrupt = new SqliteProposalStore({ path });
  assert.throws(() => metadataCorrupt.get(approved.id), (error: unknown) => (
    error instanceof ProposalStoreError && error.code === "corrupt_store"
  ));
  assert.throws(() => metadataCorrupt.list(), (error: unknown) => (
    error instanceof ProposalStoreError && error.code === "corrupt_store"
  ));
  metadataCorrupt.close();

  const rawAudit = new DatabaseSync(path);
  rawAudit.prepare("UPDATE proposals SET status = ?, revision = ?, updated_at = ?, payload_json = ? WHERE proposal_id = ?")
    .run("approved", 2, approved.updatedAt, JSON.stringify({
      ...approved,
      audit: [...approved.audit, { ...approved.audit[1], id: "audit-extra", revision: 3 }],
    }), approved.id);
  rawAudit.close();
  const auditCorrupt = new SqliteProposalStore({ path });
  assert.throws(
    () => auditCorrupt.withApprovedProposalAtRevision(approved.id, 2, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "corrupt_store",
  );
  auditCorrupt.close();
  await rm(directory, { recursive: true, force: true });
});

test("retention projection revalidates the proposal row before returning journal pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-retention-integrity-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt });
  const proposal = store.create(input({
    idempotencyKey: "retention-integrity",
    evidence: {
      references: [{
        bridgeId: "ha-main",
        hwId: "hw-7",
        capabilityId: "hwc-4",
        observedAt: "2026-08-19T00:59:00.000Z",
        source: "post-baseline-event",
        epochId: "epoch-3",
        seq: 605,
      }],
      watermarks: [{
        bridgeId: "ha-main",
        epochId: "epoch-3",
        lastSeq: 606,
        freshness: "fresh",
        gapCount: 0,
      }],
      temporal: {
        requestedSince: "2026-08-19T00:00:00.000Z",
        requestedUntil: "2026-08-19T01:00:00.000Z",
        truncated: false,
        coverage: [{
          bridgeId: "ha-main",
          epochId: "epoch-3",
          baselineSeq: 1,
          baselineAt: "2026-08-18T23:00:00.000Z",
          status: "complete",
          reasons: [],
        }],
      },
    },
  }));
  store.close();

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE proposals SET revision = ? WHERE proposal_id = ?").run(2, proposal.id);
  raw.close();
  const reopened = new SqliteProposalStore({ path });
  assert.throws(
    () => reopened.withRetentionEvidence("ha-main", 1_000, () => undefined),
    (error: unknown) => error instanceof ProposalStoreError && error.code === "corrupt_store",
  );
  reopened.close();
  await rm(directory, { recursive: true, force: true });
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

type PreparationJobStage = "artifact" | "evidence" | "authority" | "risk" | "compile" | "dry-run";
type PreparationJobErrorCode =
  | "not_found"
  | "unavailable"
  | "malformed_dependency"
  | "policy_blocked"
  | "persistence_failed"
  | "attempt_exhausted";

type PreparationJob = {
  readonly schemaVersion: "1";
  readonly kind: "approved-proposal-preparation";
  readonly jobId: string;
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly idempotencyKey: string;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly attempt: number;
  readonly version: number;
  readonly stage?: PreparationJobStage;
  readonly artifact?: Record<string, unknown>;
  readonly error?: { readonly stage: PreparationJobStage; readonly code: PreparationJobErrorCode };
  readonly createdAt: string;
  readonly updatedAt: string;
};

type PreparationJobStoreApi = {
  readonly listPreparationJobs: () => readonly PreparationJob[];
  readonly getPreparationJob: (jobId: string) => PreparationJob | undefined;
  readonly claimPreparationJob: (input: {
    readonly jobId: string;
    readonly expectedVersion: number;
  }) => PreparationJob;
  readonly completePreparationJob: (input: {
    readonly jobId: string;
    readonly expectedVersion: number;
  }) => PreparationJob;
  readonly failPreparationJob: (input: {
    readonly jobId: string;
    readonly expectedVersion: number;
    readonly stage: PreparationJobStage;
    readonly code: PreparationJobErrorCode;
  }) => PreparationJob;
  readonly retryPreparationJob: (input: {
    readonly jobId: string;
    readonly expectedVersion: number;
  }) => PreparationJob;
};

function preparationJobs(store: SqliteProposalStore): PreparationJobStoreApi {
  return store as unknown as PreparationJobStoreApi;
}

function approvedPreparationJob(store: SqliteProposalStore, idempotencyKey: string): PreparationJob {
  const proposal = store.create(input({ idempotencyKey, artifactCandidate }));
  const approved = store.review({
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  const jobs = preparationJobs(store).listPreparationJobs();
  const job = jobs.find((candidate) => candidate.proposalId === approved.id);
  assert.ok(job);
  return job;
}

function assertJobTransitionConflict(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof ProposalStoreError);
}

test("approving one qualifying revision durably enqueues exactly one bounded job, while other reviews do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-preparation-enqueue-"));
  const path = join(directory, "proposals.sqlite");
  const store = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    const proposal = store.create(input({ idempotencyKey: "preparation:approved", artifactCandidate }));
    const approved = store.review({
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });

    const jobs = preparationJobs(store).listPreparationJobs();
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], {
      schemaVersion: "1",
      kind: "approved-proposal-preparation",
      jobId: jobs[0]!.jobId,
      proposalId: approved.id,
      proposalRevision: approved.revision,
      idempotencyKey: jobs[0]!.idempotencyKey,
      status: "queued",
      attempt: 1,
      version: jobs[0]!.version,
      createdAt,
      updatedAt: createdAt,
    });
    assert.equal(jobs[0]!.proposalRevision, 2);
    assert.equal(JSON.stringify(jobs[0]).includes(proposal.title), false);
    assert.equal(JSON.stringify(jobs[0]).includes("restore_previous_state"), false);

    const rejected = store.create(input({ idempotencyKey: "preparation:rejected", artifactCandidate }));
    store.review({
      proposalId: rejected.id,
      expectedRevision: rejected.revision,
      decision: "rejected",
      reviewer: "household-owner",
      feedbackCode: "not_useful",
    });
    const expired = store.create(input({ idempotencyKey: "preparation:expired", artifactCandidate }));
    store.review({
      proposalId: expired.id,
      expectedRevision: expired.revision,
      decision: "expired",
      reviewer: "household-owner",
    });
    const insight = store.create(input({ kind: "household-insight", idempotencyKey: "preparation:insight" }));
    store.review({
      proposalId: insight.id,
      expectedRevision: insight.revision,
      decision: "approved",
      reviewer: "household-owner",
      feedbackCode: "useful_as_is",
    });
    assert.equal(preparationJobs(store).listPreparationJobs().length, 1);

    store.close();
    const reopened = new SqliteProposalStore({ path, now: () => createdAt });
    try {
      assert.equal(preparationJobs(reopened).listPreparationJobs().length, 1);
      assert.equal(preparationJobs(reopened).listPreparationJobs()[0]?.status, "queued");
      assert.equal(reopened.get(approved.id)?.status, "approved");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("claims a queued preparation job once with an expected version across store connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-preparation-claim-"));
  const path = join(directory, "proposals.sqlite");
  const first = new SqliteProposalStore({ path, now: () => createdAt });
  const second = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    const queued = approvedPreparationJob(first, "preparation:claim");
    const claimed = preparationJobs(first).claimPreparationJob({
      jobId: queued.jobId,
      expectedVersion: queued.version,
    });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempt, 1);
    assert.ok(claimed.version > queued.version);
    assert.equal(preparationJobs(second).getPreparationJob(queued.jobId)?.status, "running");
    assertJobTransitionConflict(() => preparationJobs(second).claimPreparationJob({
      jobId: queued.jobId,
      expectedVersion: queued.version,
    }));
    assert.equal(preparationJobs(second).getPreparationJob(queued.jobId)?.status, "running");
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("records precise succeeded and failed preparation job states without unbounded error text", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const successQueued = approvedPreparationJob(store, "preparation:complete");
    const successRunning = preparationJobs(store).claimPreparationJob({
      jobId: successQueued.jobId,
      expectedVersion: successQueued.version,
    });
    const succeeded = preparationJobs(store).completePreparationJob({
      jobId: successRunning.jobId,
      expectedVersion: successRunning.version,
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.attempt, 1);
    assert.equal(succeeded.stage, undefined);
    assert.equal(succeeded.error, undefined);
    assertJobTransitionConflict(() => preparationJobs(store).completePreparationJob({
      jobId: succeeded.jobId,
      expectedVersion: succeeded.version,
    }));

    const failedQueued = approvedPreparationJob(store, "preparation:fail");
    const failedRunning = preparationJobs(store).claimPreparationJob({
      jobId: failedQueued.jobId,
      expectedVersion: failedQueued.version,
    });
    const failed = preparationJobs(store).failPreparationJob({
      jobId: failedRunning.jobId,
      expectedVersion: failedRunning.version,
      stage: "compile",
      code: "unavailable",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 1);
    assert.equal(failed.stage, "compile");
    assert.deepEqual(failed.error, { stage: "compile", code: "unavailable" });
    assert.equal("message" in failed.error!, false);
    assertJobTransitionConflict(() => preparationJobs(store).failPreparationJob({
      jobId: failed.jobId,
      expectedVersion: failed.version,
      stage: "compile",
      code: "unavailable",
    }));
  } finally {
    store.close();
  }
});

test("explicitly retries only a failed preparation attempt and increments its attempt", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    const queued = approvedPreparationJob(store, "preparation:retry");
    assertJobTransitionConflict(() => preparationJobs(store).retryPreparationJob({
      jobId: queued.jobId,
      expectedVersion: queued.version,
    }));

    const running = preparationJobs(store).claimPreparationJob({
      jobId: queued.jobId,
      expectedVersion: queued.version,
    });
    assertJobTransitionConflict(() => preparationJobs(store).retryPreparationJob({
      jobId: running.jobId,
      expectedVersion: running.version,
    }));
    const failed = preparationJobs(store).failPreparationJob({
      jobId: running.jobId,
      expectedVersion: running.version,
      stage: "artifact",
      code: "persistence_failed",
    });
    const retried = preparationJobs(store).retryPreparationJob({
      jobId: failed.jobId,
      expectedVersion: failed.version,
    });
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempt, failed.attempt + 1);
    assert.ok(retried.version > failed.version);
    assert.equal(retried.stage, undefined);
    assert.equal(retried.error, undefined);

    const succeededRunning = preparationJobs(store).claimPreparationJob({
      jobId: retried.jobId,
      expectedVersion: retried.version,
    });
    const succeeded = preparationJobs(store).completePreparationJob({
      jobId: succeededRunning.jobId,
      expectedVersion: succeededRunning.version,
    });
    assert.equal(succeeded.status, "succeeded");
    assertJobTransitionConflict(() => preparationJobs(store).retryPreparationJob({
      jobId: succeeded.jobId,
      expectedVersion: succeeded.version,
    }));
  } finally {
    store.close();
  }
});

test("fails closed after five preparation attempts", () => {
  const store = new SqliteProposalStore({ path: ":memory:", now: () => createdAt });
  try {
    let job = approvedPreparationJob(store, "preparation:attempt-limit");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const running = preparationJobs(store).claimPreparationJob({
        jobId: job.jobId,
        expectedVersion: job.version,
      });
      const failed = preparationJobs(store).failPreparationJob({
        jobId: running.jobId,
        expectedVersion: running.version,
        stage: "compile",
        code: "unavailable",
      });
      assert.equal(failed.attempt, attempt);
      if (attempt === 5) {
        assertJobTransitionConflict(() => preparationJobs(store).retryPreparationJob({
          jobId: failed.jobId,
          expectedVersion: failed.version,
        }));
        assert.equal(preparationJobs(store).getPreparationJob(failed.jobId)?.status, "failed");
      } else {
        job = preparationJobs(store).retryPreparationJob({
          jobId: failed.jobId,
          expectedVersion: failed.version,
        });
      }
    }
  } finally {
    store.close();
  }
});

test("reopening the proposal store preserves queued and running preparation jobs without auto-claiming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-proposal-preparation-restart-"));
  const path = join(directory, "proposals.sqlite");
  const first = new SqliteProposalStore({ path, now: () => createdAt });
  let queued: PreparationJob;
  try {
    queued = approvedPreparationJob(first, "preparation:restart");
  } finally {
    first.close();
  }

  const reopened = new SqliteProposalStore({ path, now: () => createdAt });
  try {
    const persistedQueued = preparationJobs(reopened).getPreparationJob(queued!.jobId);
    assert.equal(persistedQueued?.status, "queued");
    assert.equal(persistedQueued?.attempt, 1);
    const running = preparationJobs(reopened).claimPreparationJob({
      jobId: queued!.jobId,
      expectedVersion: persistedQueued!.version,
    });
    reopened.close();

    const restartedAgain = new SqliteProposalStore({ path, now: () => createdAt });
    try {
      const persistedRunning = preparationJobs(restartedAgain).getPreparationJob(running.jobId);
      assert.equal(persistedRunning?.status, "running");
      assert.equal(persistedRunning?.attempt, 1);
      assert.equal(persistedRunning?.version, running.version);
    } finally {
      restartedAgain.close();
    }
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});
