import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactPreparationService,
  ArtifactPreparationServiceError,
  type ArtifactPreparationReceipt,
} from "./artifact-preparation-service.js";
import {
  SqliteProposalStore,
} from "../home/proposal-store.js";
import type { ArtifactPreparationJob } from "./preparation-job-port.js";
import { ArtifactPreparationJobRunner } from "./artifact-preparation-job-runner.js";

const createdAt = "2026-08-21T01:00:00.000Z";
const artifactRef = Object.freeze({
  artifactId: "artifact-job-runner-fixture",
  revision: 1,
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const preparationReceipt: ArtifactPreparationReceipt = Object.freeze({
  mutation: Object.freeze({
    artifact: artifactRef,
    evidence: Object.freeze({
      attestationId: "evidence-job-runner-fixture",
      inputIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
    authority: Object.freeze({
      assessmentId: "authority-job-runner-fixture",
      inputIdentity: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }),
    risk: Object.freeze({
      assessmentId: "risk-job-runner-fixture",
      inputIdentity: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }),
  }),
  compilation: Object.freeze({
    artifact: artifactRef,
    compile: Object.freeze({
      resultId: "compile-job-runner-fixture",
      inputIdentity: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      status: "compiled" as const,
    }),
    dryRun: Object.freeze({
      resultId: "dry-run-job-runner-fixture",
      inputIdentity: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      status: "passed" as const,
      writesPerformed: false as const,
    }),
  }),
});

type JobStorePort = Pick<SqliteProposalStore,
  "claimPreparationJob" | "completePreparationJob" | "failPreparationJob"
>;

type JobStoreSpies = {
  claims: number;
  completes: number;
  failures: number;
  scans: number;
};

function approvedJob(idempotencyKey: string): {
  readonly store: SqliteProposalStore;
  readonly job: ArtifactPreparationJob;
} {
  const store = new SqliteProposalStore({
    path: ":memory:",
    now: () => createdAt,
    id: (() => {
      let sequence = 0;
      return () => `job-runner-${++sequence}`;
    })(),
  });
  const pending = store.create({
    kind: "automation-draft",
    title: "Review a local household note",
    summary: "A bounded fixture proposal for the private preparation worker.",
    idempotencyKey,
    provenance: { producer: "job-runner-fixture" },
    evidence: {
      references: [],
      watermarks: [{
        bridgeId: "bridge-job-runner-fixture",
        epochId: "epoch-job-runner-fixture",
        lastSeq: 1,
        freshness: "fresh",
        gapCount: 0,
      }],
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    dryRun: { status: "not_run", summary: "No artifact has been prepared." },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    intent: {
      type: "notify_local",
      description: "Prepare a local review note.",
      rollback: "No remote change exists.",
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: {
        trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
        conditions: [],
        actions: [{ kind: "notify_local", message: "Review the household note." }],
        rollback: { kind: "no_remote_change" },
        postconditions: [],
      },
    },
  });
  const approved = store.review({
    proposalId: pending.id,
    expectedRevision: pending.revision,
    decision: "approved",
    reviewer: "household-owner",
    feedbackCode: "useful_as_is",
  });
  const job = store.listPreparationJobs().find((candidate) => candidate.proposalId === approved.id);
  assert.ok(job);
  return { store, job };
}

function jobPort(store: SqliteProposalStore, spies: JobStoreSpies): JobStorePort & {
  readonly listPreparationJobs: () => readonly ArtifactPreparationJob[];
} {
  return {
    claimPreparationJob(input) {
      spies.claims += 1;
      return store.claimPreparationJob(input);
    },
    completePreparationJob(input) {
      spies.completes += 1;
      return store.completePreparationJob(input);
    },
    failPreparationJob(input) {
      spies.failures += 1;
      return store.failPreparationJob(input);
    },
    listPreparationJobs() {
      spies.scans += 1;
      return store.listPreparationJobs();
    },
  };
}

function preparation(
  run: (command: { readonly proposalId: string; readonly proposalRevision: number }) => Promise<ArtifactPreparationReceipt>,
): ArtifactPreparationService {
  return new ArtifactPreparationService({ pipeline: { run } });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("claims the queued job first, prepares its exact proposal revision, then completes it", async () => {
  const { store, job } = approvedJob("runner:success");
  const spies: JobStoreSpies = { claims: 0, completes: 0, failures: 0, scans: 0 };
  const commands: Array<{ readonly proposalId: string; readonly proposalRevision: number }> = [];
  const runner = new ArtifactPreparationJobRunner({
    jobs: jobPort(store, spies),
    preparation: preparation(async (command) => {
      commands.push(command);
      return preparationReceipt;
    }),
  });

  try {
    await runner.run(job.jobId, job.version);
    assert.equal(spies.claims, 1);
    assert.equal(spies.completes, 1);
    assert.deepEqual(commands, [{ proposalId: job.proposalId, proposalRevision: job.proposalRevision }]);
    assert.equal(store.getPreparationJob(job.jobId)?.status, "succeeded");
  } finally {
    await runner.stop();
    store.close();
  }
});

test("maps a bounded preparation failure to closed job stage/code without persisting its message", async () => {
  const { store, job } = approvedJob("runner:failure");
  const spies: JobStoreSpies = { claims: 0, completes: 0, failures: 0, scans: 0 };
  const failure = new ArtifactPreparationServiceError("compile", "malformed_result");
  failure.message = "provider-native secret route detail";
  const runner = new ArtifactPreparationJobRunner({
    jobs: jobPort(store, spies),
    preparation: preparation(async () => { throw failure; }),
  });

  try {
    await assert.rejects(runner.run(job.jobId, job.version));
    const failed = store.getPreparationJob(job.jobId);
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.error, { stage: "compile", code: "malformed_dependency" });
    assert.doesNotMatch(JSON.stringify(failed), /provider-native|secret|route detail/u);
    assert.equal(spies.failures, 1);
    assert.equal(spies.completes, 0);
  } finally {
    await runner.stop();
    store.close();
  }
});

test("coalesces concurrent runs for one job into one claim, preparation, and completion", async () => {
  const { store, job } = approvedJob("runner:single-flight");
  const spies: JobStoreSpies = { claims: 0, completes: 0, failures: 0, scans: 0 };
  const started = deferred<void>();
  const gate = deferred<ArtifactPreparationReceipt>();
  let preparations = 0;
  const runner = new ArtifactPreparationJobRunner({
    jobs: jobPort(store, spies),
    preparation: preparation(async () => {
      preparations += 1;
      started.resolve();
      return gate.promise;
    }),
  });

  try {
    const first = runner.run(job.jobId, job.version);
    await started.promise;
    const second = runner.run(job.jobId, job.version);
    assert.equal(preparations, 1);
    gate.resolve(preparationReceipt);
    await Promise.all([first, second]);
    assert.equal(spies.claims, 1);
    assert.equal(spies.completes, 1);
    assert.equal(store.getPreparationJob(job.jobId)?.status, "succeeded");
  } finally {
    await runner.stop();
    store.close();
  }
});

test("stop rejects new runs and waits for an in-flight preparation", async () => {
  const first = approvedJob("runner:stop:first");
  const second = approvedJob("runner:stop:second");
  const spies: JobStoreSpies = { claims: 0, completes: 0, failures: 0, scans: 0 };
  const started = deferred<void>();
  const gate = deferred<ArtifactPreparationReceipt>();
  const runner = new ArtifactPreparationJobRunner({
    jobs: jobPort(first.store, spies),
    preparation: preparation(async (command) => {
      assert.equal(command.proposalId, first.job.proposalId);
      started.resolve();
      return gate.promise;
    }),
  });

  try {
    const inFlight = runner.run(first.job.jobId, first.job.version);
    await started.promise;
    const stopping = runner.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(runner.run(second.job.jobId, second.job.version));
    assert.equal(first.store.getPreparationJob(first.job.jobId)?.status, "running");
    gate.resolve(preparationReceipt);
    await inFlight;
    await stopping;
    assert.equal(stopped, true);
  } finally {
    await runner.stop();
    first.store.close();
    second.store.close();
  }
});

test("construction and start do not scan or auto-claim an existing queued job", async () => {
  const { store, job } = approvedJob("runner:startup");
  const spies: JobStoreSpies = { claims: 0, completes: 0, failures: 0, scans: 0 };
  const runner = new ArtifactPreparationJobRunner({
    jobs: jobPort(store, spies),
    preparation: preparation(async () => preparationReceipt),
  });

  try {
    assert.equal(spies.claims, 0);
    assert.equal(spies.scans, 0);
    await runner.start();
    assert.equal(spies.claims, 0);
    assert.equal(spies.scans, 0);
    assert.equal(store.getPreparationJob(job.jobId)?.status, "queued");
  } finally {
    await runner.stop();
    store.close();
  }
});
