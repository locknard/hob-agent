import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteObservationAuditStore } from "./observation-audit-store.js";

test("persists only bounded observation lifecycle metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-observation-audit-"));
  const path = join(directory, "observations.sqlite");
  const first = new SqliteObservationAuditStore({
    path,
    idFactory: () => "observation-1",
  });

  const id = first.begin({
    trigger: "scheduled",
    startedAt: "2026-08-19T04:00:00.000Z",
  });
  assert.equal(id, "observation-1");
  assert.deepEqual(first.list({ limit: 10 }), [{
    id: "observation-1",
    trigger: "scheduled",
    startedAt: "2026-08-19T04:00:00.000Z",
    status: "running",
  }]);

  first.complete({
    id,
    completedAt: "2026-08-19T04:00:03.000Z",
    outcome: "no_proposal",
    disposition: "insufficient_evidence",
    metrics: {
      durationMs: 2_500,
      inputTokens: 120,
      outputTokens: 18,
      reasoningTokens: 7,
      toolCalls: 6,
      failedToolCalls: 0,
    },
  });
  first.close();

  const reopened = new SqliteObservationAuditStore({ path });
  assert.deepEqual(reopened.list({ limit: 10 }), [{
    id: "observation-1",
    trigger: "scheduled",
    startedAt: "2026-08-19T04:00:00.000Z",
    completedAt: "2026-08-19T04:00:03.000Z",
    status: "completed",
    outcome: "no_proposal",
    disposition: "insufficient_evidence",
    metrics: {
      durationMs: 2_500,
      inputTokens: 120,
      outputTokens: 18,
      reasoningTokens: 7,
      toolCalls: 6,
      failedToolCalls: 0,
    },
  }]);
  assert.deepEqual(reopened.summary(), {
    totalAttempts: 1,
    completedAttempts: 1,
    interruptedAttempts: 0,
    runningAttempts: 0,
    outcomes: {
      proposal_created: 0,
      no_proposal: 1,
      world_not_ready: 0,
      proposal_pending: 0,
      agent_busy: 0,
      failed: 0,
    },
    dispositions: {
      no_material_value: 0,
      insufficient_evidence: 1,
      existing_rule_overlap: 0,
      mapping_uncertain: 0,
      other_uncertainty: 0,
    },
    noProposalWithoutDisposition: 0,
  });
  reopened.close();

  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("fails closed on invalid, duplicate, or mismatched lifecycle writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-observation-audit-invalid-"));
  const store = new SqliteObservationAuditStore({
    path: join(directory, "observations.sqlite"),
    idFactory: () => "observation-1",
  });

  assert.throws(() => store.begin({
    trigger: "scheduled",
    startedAt: "not-a-time",
  }), /invalid observation audit/i);

  const id = store.begin({ trigger: "manual", startedAt: "2026-08-19T04:00:00.000Z" });
  assert.throws(
    () => store.begin({ trigger: "manual", startedAt: "2026-08-19T04:00:01.000Z" }),
    /observation audit conflict/i,
  );
  assert.throws(() => store.complete({
    id: "unknown",
    completedAt: "2026-08-19T04:00:02.000Z",
    outcome: "failed",
  }), /observation audit conflict/i);
  assert.throws(() => store.complete({
    id,
    completedAt: "2026-08-19T03:59:59.000Z",
    outcome: "failed",
  }), /invalid observation audit/i);
  assert.throws(() => store.complete({
    id,
    completedAt: "2026-08-19T04:00:02.000Z",
    outcome: "failed",
    metrics: {
      durationMs: -1,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0,
      failedToolCalls: 0,
    },
  }), /invalid observation audit/i);
  assert.throws(() => store.complete({
    id,
    completedAt: "2026-08-19T04:00:02.000Z",
    outcome: "failed",
    disposition: "insufficient_evidence",
  }), /invalid observation audit/i);

  store.close();
});

test("returns newest attempts first with a bounded query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-observation-audit-order-"));
  let nextId = 0;
  const store = new SqliteObservationAuditStore({
    path: join(directory, "observations.sqlite"),
    idFactory: () => `observation-${++nextId}`,
  });
  for (const hour of [1, 2, 3]) {
    const startedAt = `2026-08-19T0${hour}:00:00.000Z`;
    const id = store.begin({ trigger: "one_shot", startedAt });
    store.complete({ id, completedAt: `2026-08-19T0${hour}:00:01.000Z`, outcome: "no_proposal" });
  }

  assert.deepEqual(store.list({ limit: 2 }).map((attempt) => attempt.id), [
    "observation-3",
    "observation-2",
  ]);
  assert.throws(() => store.list({ limit: 0 }), /invalid observation audit query/i);
  assert.throws(() => store.list({ limit: 101 }), /invalid observation audit query/i);
  store.close();
});

test("marks only unfinished attempts from a previous process as interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-observation-audit-restart-"));
  const path = join(directory, "observations.sqlite");
  const first = new SqliteObservationAuditStore({ path, idFactory: () => "observation-1" });
  first.begin({ trigger: "startup", startedAt: "2026-08-19T04:00:00.000Z" });
  assert.equal(first.list()[0]?.status, "running");
  first.close();

  const reopened = new SqliteObservationAuditStore({ path });
  assert.deepEqual(reopened.list(), [{
    id: "observation-1",
    trigger: "startup",
    startedAt: "2026-08-19T04:00:00.000Z",
    status: "interrupted",
  }]);
  reopened.close();
});
