import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArtifactCompilationReceipt,
  ArtifactCompilationCoordinator,
} from "./artifact-compilation-coordinator.js";
import { ArtifactCompilationCoordinatorError } from "./artifact-compilation-coordinator.js";
import type {
  ArtifactMutationCoordinator,
  ArtifactMutationProposalCommand,
  ArtifactMutationReceipt,
} from "./artifact-mutation-coordinator.js";
import { ArtifactMutationCoordinatorError } from "./artifact-mutation-coordinator.js";
import {
  ArtifactPreparationService,
  ArtifactPreparationServiceError,
} from "./artifact-preparation-service.js";
import type { ArtifactRef } from "./neutral-artifact.js";

const command: ArtifactMutationProposalCommand = Object.freeze({
  proposalId: "proposal-preparation-service-1",
  proposalRevision: 3,
});

const artifactRef: ArtifactRef = Object.freeze({
  artifactId: "artifact-preparation-service-1",
  revision: 1,
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

const mutationReceipt: ArtifactMutationReceipt = Object.freeze({
  artifact: artifactRef,
  evidence: Object.freeze({
    attestationId: "evidence-preparation-service-1",
    inputIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }),
  authority: Object.freeze({
    assessmentId: "authority-preparation-service-1",
    inputIdentity: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  }),
  risk: Object.freeze({
    assessmentId: "risk-preparation-service-1",
    inputIdentity: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  }),
});

const compilationReceipt: ArtifactCompilationReceipt = Object.freeze({
  artifact: artifactRef,
  compile: Object.freeze({
    resultId: "compile-result-preparation-service-1",
    inputIdentity: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    status: "compiled",
  }),
  dryRun: Object.freeze({
    resultId: "dry-run-result-preparation-service-1",
    inputIdentity: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    status: "passed",
    writesPerformed: false as const,
  }),
});

type MutationPort = Pick<ArtifactMutationCoordinator, "fromApprovedProposal">;
type CompilationPort = Pick<ArtifactCompilationCoordinator, "compile">;

function service(mutation: MutationPort, compilation: CompilationPort): ArtifactPreparationService {
  return new ArtifactPreparationService({ mutation, compilation } as never);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("coalesces concurrent calls for the same approved proposal command into one mutation and compile", async () => {
  let mutationCalls = 0;
  let compileCalls = 0;
  const gate = deferred<ArtifactCompilationReceipt>();
  const mutation: MutationPort = {
    fromApprovedProposal(input) {
      mutationCalls += 1;
      assert.deepEqual(input, command);
      return mutationReceipt;
    },
  };
  const compilation: CompilationPort = {
    compile(input) {
      compileCalls += 1;
      assert.deepEqual(input, artifactRef);
      return gate.promise;
    },
  };
  const preparation = service(mutation, compilation);

  const first = preparation.prepare(command);
  const second = preparation.prepare({ ...command });

  assert.strictEqual(first, second);
  assert.equal(mutationCalls, 1);
  assert.equal(compileCalls, 1);

  gate.resolve(compilationReceipt);
  const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
  assert.deepEqual(firstReceipt, secondReceipt);
});

test("passes the exact artifact ref produced by mutation to compilation", async () => {
  const compiledInputs: ArtifactRef[] = [];
  const preparation = service(
    {
      fromApprovedProposal: () => mutationReceipt,
    },
    {
      compile(input) {
        compiledInputs.push(input);
        return Promise.resolve(compilationReceipt);
      },
    },
  );

  await preparation.prepare(command);

  assert.equal(compiledInputs.length, 1);
  assert.strictEqual(compiledInputs[0], mutationReceipt.artifact);
  assert.deepEqual(compiledInputs[0], artifactRef);
});

test("does not invoke compilation when mutation fails", async () => {
  let compileCalls = 0;
  const preparation = service(
    {
      fromApprovedProposal: () => {
        throw new Error("mutation provider-native detail");
      },
    },
    {
      compile: () => {
        compileCalls += 1;
        return Promise.resolve(compilationReceipt);
      },
    },
  );

  await assert.rejects(preparation.prepare(command));
  assert.equal(compileCalls, 0);
});

test("preserves a bounded mutation coordinator stage without leaking producer details", async () => {
  const preparation = service(
    {
      fromApprovedProposal: () => {
        throw new ArtifactMutationCoordinatorError("evidence", "producer_failed");
      },
    },
    { compile: () => Promise.resolve(compilationReceipt) },
  );

  await assert.rejects(
    preparation.prepare(command),
    (error: unknown) => error instanceof ArtifactPreparationServiceError
      && error.stage === "evidence"
      && error.code === "failed"
      && !error.message.includes("producer"),
  );
});

test("normalizes compiler failures to a bounded stage/code error without leaking the original message", async () => {
  const originalMessage = "provider-native detail https://user:secret@example.invalid/route";
  const preparation = service(
    {
      fromApprovedProposal: () => mutationReceipt,
    },
    {
      compile: async () => {
        throw new Error(originalMessage);
      },
    },
  );

  await assert.rejects(
    preparation.prepare(command),
    (error: unknown) => error instanceof ArtifactPreparationServiceError
      && error.stage === "compile"
      && error.code === "failed"
      && !error.message.includes(originalMessage)
      && !error.message.includes("provider-native")
      && !error.message.includes("secret")
      && !error.message.includes("example.invalid"),
  );
});

test("preserves a bounded compilation coordinator stage without leaking dependency details", async () => {
  const preparation = service(
    { fromApprovedProposal: () => mutationReceipt },
    {
      compile: async () => {
        throw new ArtifactCompilationCoordinatorError("world-cut", "unavailable");
      },
    },
  );

  await assert.rejects(
    preparation.prepare(command),
    (error: unknown) => error instanceof ArtifactPreparationServiceError
      && error.stage === "world-cut"
      && error.code === "failed"
      && !error.message.includes("dependency"),
  );
});

test("stop rejects new commands and waits for the in-flight preparation", async () => {
  const gate = deferred<ArtifactCompilationReceipt>();
  let compileCalls = 0;
  const preparation = service(
    {
      fromApprovedProposal: () => mutationReceipt,
    },
    {
      compile: () => {
        compileCalls += 1;
        return gate.promise;
      },
    },
  );

  const inFlight = preparation.prepare(command);
  const stop = preparation.stop();
  let stopped = false;
  void stop.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(compileCalls, 1);
  assert.equal(stopped, false);
  await assert.rejects(preparation.prepare({ proposalId: "proposal-preparation-service-2", proposalRevision: 1 }));

  gate.resolve(compilationReceipt);
  await inFlight;
  await stop;
  assert.equal(stopped, true);
});

test("returns a metadata-only receipt without route, native, or credential fields", async () => {
  const preparation = service(
    {
      fromApprovedProposal: () => mutationReceipt,
    },
    {
      compile: () => Promise.resolve(compilationReceipt),
    },
  );

  const receipt = await preparation.prepare(command);
  const serialized = JSON.stringify(receipt);

  assert.ok(receipt);
  assert.doesNotMatch(serialized, /route/i);
  assert.doesNotMatch(serialized, /native/i);
  assert.doesNotMatch(serialized, /credential/i);
});

test("accepts one root-private asynchronous pipeline port without exposing its dependencies", async () => {
  let calls = 0;
  const preparation = new ArtifactPreparationService({
    pipeline: {
      async run(input) {
        calls += 1;
        assert.deepEqual(input, command);
        return { mutation: mutationReceipt, compilation: compilationReceipt };
      },
    },
  } as never);

  const first = preparation.prepare(command);
  const second = preparation.prepare({ ...command });
  assert.strictEqual(first, second);
  assert.deepEqual(await first, { mutation: mutationReceipt, compilation: compilationReceipt });
  assert.equal(calls, 1);
  assert.equal("pipeline" in preparation, false);
});
