import assert from "node:assert/strict";
import test from "node:test";

import { recoverMigrationPreparationHandoffs } from "./migration-preparation-recovery.js";

test("recovers selection links before replaying only bounded succeeded preparation handoffs", async () => {
  const calls: string[] = [];
  let requestedLimit = 0;

  await recoverMigrationPreparationHandoffs({
    jobs: {
      listPreparationJobs(limit) {
        requestedLimit = limit;
        return [
          { proposalId: "proposal-ready-a", status: "succeeded" },
          { proposalId: "proposal-running", status: "running" },
          { proposalId: "proposal-ready-b", status: "succeeded" },
        ];
      },
    },
    migrations: {
      async recoverMigrationSelections() {
        calls.push("selections");
      },
      async refreshPreparedWorkflowForProposal(proposalId) {
        calls.push(`refresh:${proposalId}`);
      },
    },
  });

  assert.equal(requestedLimit, 100);
  assert.deepEqual(calls, [
    "selections",
    "refresh:proposal-ready-a",
    "refresh:proposal-ready-b",
  ]);
});
test("isolates corrupt recovery rows and never widens the bounded scan", async () => {
  const calls: string[] = [];

  await recoverMigrationPreparationHandoffs({
    jobs: {
      listPreparationJobs(limit) {
        assert.equal(limit, 100);
        return [
          { proposalId: "proposal-bad", status: "succeeded" },
          { proposalId: "proposal-good", status: "succeeded" },
        ];
      },
    },
    migrations: {
      async recoverMigrationSelections() {
        calls.push("selections");
        throw new Error("corrupt selection row");
      },
      async refreshPreparedWorkflowForProposal(proposalId) {
        calls.push(`refresh:${proposalId}`);
        if (proposalId === "proposal-bad") throw new Error("corrupt workflow row");
      },
    },
  });

  assert.deepEqual(calls, [
    "selections",
    "refresh:proposal-bad",
    "refresh:proposal-good",
  ]);
});
