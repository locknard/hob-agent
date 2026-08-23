import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductVoiceCleanupLedger } from "./product-voice-cleanup-ledger.js";

const asrRef = "keychain:hob-agent/voice:asr:candidate-a:credential-a";
const ttsRef = "keychain:hob-agent/voice:tts:candidate-a:credential-b";

test("durably reserves and retires exact voice references without persisting credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory, () => new Date("2026-08-24T10:00:00.000Z"));
    await ledger.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 7 });
    await ledger.markCommitted({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 7, committedGeneration: 8 });
    assert.deepEqual(await ledger.listPending(), []);
    await ledger.retire({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, committedGeneration: 8 });
    const [pending] = await ledger.listPending();
    assert.deepEqual(pending, {
      candidateId: "candidate-a", track: "asr", credentialRef: asrRef,
      phase: "pending_cleanup", reason: "retired", expectedGeneration: 7,
      committedGeneration: 8, createdAt: "2026-08-24T10:00:00.000Z", attempts: 0,
    });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "product-voice-cleanup-ledger.json"))).mode & 0o777, 0o600);
    const source = await readFile(join(directory, "product-voice-cleanup-ledger.json"), "utf8");
    assert.equal(source.includes("raw-provider-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses exact references for retry accounting and acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-retry-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    await ledger.reserve({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef, expectedGeneration: 1 });
    await ledger.markCommitted({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef, expectedGeneration: 1, committedGeneration: 2 });
    await ledger.retire({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef, committedGeneration: 2 });
    await ledger.markCleanupAttempt({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef });
    await ledger.markCleanupAttempt({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef });
    assert.equal((await ledger.listPending())[0]?.attempts, 2);
    await ledger.acknowledge({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef });
    assert.deepEqual(await ledger.listPending(), []);
    await assert.rejects(ledger.acknowledge({ candidateId: "candidate-a", track: "tts", credentialRef: asrRef }), /invalid/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a staged candidate into exact pending cleanup after an interrupted request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-recover-"));
  try {
    const first = new ProductVoiceCleanupLedger(directory);
    await first.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 4 });
    const recovered = new ProductVoiceCleanupLedger(directory);
    assert.equal((await recovered.load()).entries[0]?.phase, "staged");
    await recovered.abandonStaged({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef });
    const [pending] = await recovered.listPending();
    assert.equal(pending?.phase, "pending_cleanup");
    assert.equal(pending?.reason, "candidate_abandoned");
    assert.equal(pending?.credentialRef, asrRef);
    assert.equal(pending?.expectedGeneration, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopts a generation-one voice locator as idempotent active ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-adopt-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    await ledger.adoptCommitted({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, committedGeneration: 1 });
    await ledger.adoptCommitted({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, committedGeneration: 1 });
    const [entry] = (await ledger.load()).entries;
    assert.equal((await ledger.load()).entries.length, 1);
    assert.equal(entry?.candidateId, "candidate-a");
    assert.equal(entry?.track, "asr");
    assert.equal(entry?.credentialRef, asrRef);
    assert.equal(entry?.phase, "active");
    assert.equal(entry?.reason, "configuration_committed");
    assert.equal(entry?.expectedGeneration, 0);
    assert.equal(entry?.committedGeneration, 1);
    assert.equal(entry?.attempts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps exact active voice ownership when a model change advances the global generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-unrelated-generation-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    await ledger.reserve({
      candidateId: "candidate-a",
      track: "asr",
      credentialRef: asrRef,
      expectedGeneration: 1,
    });
    await ledger.markCommitted({
      candidateId: "candidate-a",
      track: "asr",
      credentialRef: asrRef,
      expectedGeneration: 1,
      committedGeneration: 2,
    });

    await ledger.adoptCommitted({
      candidateId: "candidate-a",
      track: "asr",
      credentialRef: asrRef,
      committedGeneration: 8,
    });

    const [entry] = (await ledger.load()).entries;
    assert.equal(entry?.phase, "active");
    assert.equal(entry?.expectedGeneration, 1);
    assert.equal(entry?.committedGeneration, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid or conflicting adoption of committed voice ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-adopt-conflict-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    await ledger.adoptCommitted({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, committedGeneration: 1 });
    await assert.rejects(ledger.adoptCommitted({ candidateId: "candidate-a", track: "asr", credentialRef: ttsRef, committedGeneration: 2 }), /invalid/i);
    await assert.rejects(ledger.adoptCommitted({
      candidateId: "candidate-a", track: "asr", credentialRef: "keychain:hob-agent/voice:asr:candidate-b:credential-a", committedGeneration: 2,
    }), /invalid/i);
    await assert.rejects(ledger.adoptCommitted({
      candidateId: "candidate-b", track: "asr", credentialRef: "keychain:hob-agent/voice:asr:candidate-b:credential-a", committedGeneration: 1,
    }), /conflict|owner/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent instances so reservations cannot lose each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-lock-"));
  try {
    const first = new ProductVoiceCleanupLedger(directory);
    const second = new ProductVoiceCleanupLedger(directory);
    await Promise.all([
      first.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 1 }),
      second.reserve({ candidateId: "candidate-a", track: "tts", credentialRef: ttsRef, expectedGeneration: 1 }),
    ]);
    assert.deepEqual((await new ProductVoiceCleanupLedger(directory).load()).entries.map((entry) => entry.credentialRef).sort(), [asrRef, ttsRef]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed, secret-shaped, duplicate, and over-capacity ledger records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-validate-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    await assert.rejects(ledger.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: "keychain:hob-agent/voice:tts:candidate-a:credential-a", expectedGeneration: 1 }), /invalid/i);
    await assert.rejects(ledger.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: "keychain:hob-agent/setup-model:candidate-a:secret", expectedGeneration: 1 }), /invalid/i);
    await ledger.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 1 });
    await assert.rejects(ledger.reserve({ candidateId: "candidate-a", track: "asr", credentialRef: asrRef, expectedGeneration: 1 }), /duplicate|invalid/i);
    await writeFile(join(directory, "product-voice-cleanup-ledger.json"), JSON.stringify({
      version: "hob.product-voice-cleanup/v1", entries: [{
        candidateId: "candidate-a", track: "asr", credentialRef: asrRef, phase: "staged", reason: "vault_write_pending",
        expectedGeneration: 1, createdAt: "2026-08-24T10:00:00.000Z", attempts: 0, rawCredential: "raw-provider-secret",
      }],
    }));
    await assert.rejects(ledger.load(), /invalid/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds pending entries and list requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-voice-cleanup-ledger-bounds-"));
  try {
    const ledger = new ProductVoiceCleanupLedger(directory);
    for (let index = 0; index < 16; index += 1) {
      await ledger.reserve({
        candidateId: `candidate-${index}`, track: "asr",
        credentialRef: `keychain:hob-agent/voice:asr:candidate-${index}:credential-a`, expectedGeneration: 1,
      });
    }
    await assert.rejects(ledger.reserve({ candidateId: "candidate-over", track: "asr", credentialRef: "keychain:hob-agent/voice:asr:candidate-over:credential-a", expectedGeneration: 1 }), /full|limit/i);
    await assert.rejects(ledger.listPending({ limit: 17 }), /limit/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
