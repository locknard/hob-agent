import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductModelCleanupLedger } from "./product-model-cleanup-ledger.js";

const reference = "keychain:hob-agent/model:candidate-a:nonce-a";

test("persists exact model credential ownership from pre-write reservation through retirement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-cleanup-ledger-"));
  try {
    const ledger = new ProductModelCleanupLedger(directory, () => new Date("2026-08-24T10:00:00.000Z"));
    await ledger.reserve({ candidateId: "candidate-a", credentialRef: reference, expectedGeneration: 4 });
    await ledger.markCommitted({ candidateId: "candidate-a", credentialRef: reference, expectedGeneration: 4, committedGeneration: 5 });
    await ledger.retire({ candidateId: "candidate-a", credentialRef: reference, committedGeneration: 5 });
    await ledger.markCleanupAttempt({ candidateId: "candidate-a", credentialRef: reference });
    assert.deepEqual(await ledger.listPending(), [{
      candidateId: "candidate-a", credentialRef: reference, phase: "pending_cleanup", reason: "retired",
      expectedGeneration: 4, committedGeneration: 5, createdAt: "2026-08-24T10:00:00.000Z", attempts: 1,
    }]);
    const source = await readFile(join(directory, "product-model-cleanup-ledger.json"), "utf8");
    assert.equal(source.includes("raw-provider-secret"), false);
    await ledger.acknowledge({ candidateId: "candidate-a", credentialRef: reference });
    assert.deepEqual(await ledger.listPending(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts an exact setup-model locator and rejects malformed model references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-cleanup-ledger-validation-"));
  try {
    const ledger = new ProductModelCleanupLedger(directory);
    const setupReference = "keychain:hob-agent/setup-model:candidate-a:nonce-a";
    await ledger.reserve({ candidateId: "candidate-a", credentialRef: setupReference, expectedGeneration: 0 });
    await ledger.markCommitted({ candidateId: "candidate-a", credentialRef: setupReference, expectedGeneration: 0, committedGeneration: 1 });
    await ledger.retire({ candidateId: "candidate-a", credentialRef: setupReference, committedGeneration: 1 });
    assert.equal((await ledger.listPending())[0]?.credentialRef, setupReference);
    await assert.rejects(ledger.reserve({ candidateId: "candidate-a", credentialRef: "keychain:hob-agent/setup-model:other-candidate:nonce-a", expectedGeneration: 1 }), /invalid/i);
    await ledger.reserve({ candidateId: "candidate-a", credentialRef: reference, expectedGeneration: 1 });
    await ledger.abandonStaged({ candidateId: "candidate-a", credentialRef: reference });
    assert.equal((await ledger.listPending()).find((entry) => entry.credentialRef === reference)?.reason, "candidate_abandoned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopts a reserved candidate after a crash between config CAS and ledger promotion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-cleanup-ledger-adopt-"));
  try {
    const ledger = new ProductModelCleanupLedger(directory);
    await ledger.reserve({ candidateId: "candidate-a", credentialRef: reference, expectedGeneration: 4 });
    await ledger.adoptCommitted({ candidateId: "candidate-a", credentialRef: reference, committedGeneration: 5 });
    const [entry] = (await ledger.load()).entries;
    assert.equal(entry?.phase, "active");
    assert.equal(entry?.committedGeneration, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps exact active ownership when an unrelated product setting advances the global generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-cleanup-ledger-unrelated-generation-"));
  try {
    const ledger = new ProductModelCleanupLedger(directory);
    const credentialRef = "keychain:hob-agent/model:candidate-stable:credential-stable";
    await ledger.reserve({ candidateId: "candidate-stable", credentialRef, expectedGeneration: 1 });
    await ledger.markCommitted({
      candidateId: "candidate-stable",
      credentialRef,
      expectedGeneration: 1,
      committedGeneration: 2,
    });

    await ledger.adoptCommitted({
      candidateId: "candidate-stable",
      credentialRef,
      committedGeneration: 9,
    });

    const [entry] = (await ledger.load()).entries;
    assert.equal(entry?.phase, "active");
    assert.equal(entry?.expectedGeneration, 1);
    assert.equal(entry?.committedGeneration, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
