import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Envelope } from "../bridge/bridge-ingest-types.js";
import { SqliteIngestJournal } from "../world/ingest-journal.js";
import { SqliteProposalStore } from "../home/proposal-store.js";

interface OperationModule {
  readonly runHomeRetentionOperation: (
    environment: Readonly<Record<string, string | undefined>>,
    args: readonly string[],
    options?: { readonly now?: () => string },
  ) => Promise<Record<string, unknown>>;
}

async function loadOperation(): Promise<OperationModule> {
  try {
    const loaded = await import("./home-retention-operation.js") as unknown as Partial<OperationModule>;
    if (typeof loaded.runHomeRetentionOperation !== "function") {
      throw new Error("runHomeRetentionOperation export is missing");
    }
    return loaded as OperationModule;
  } catch (error) {
    assert.fail(`Home retention operator facade is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const BRIDGE_ID = "bridge-a";
const NOW = "2026-08-20T00:00:00.000Z";

function environment(dataDirectory: string): Readonly<Record<string, string>> {
  return {
    HOB_DATA_DIR: dataDirectory,
    HOB_BRIDGES: JSON.stringify([{
      bridgeId: BRIDGE_ID,
      adapterType: "synthetic",
      config: {},
    }]),
    HOB_RETENTION_BRIDGE_ID: BRIDGE_ID,
    HOB_RETENTION_REASON: "manual bounded evidence maintenance",
  };
}

function seedJournal(dataDirectory: string): void {
  const journal = new SqliteIngestJournal(join(dataDirectory, `${encodeURIComponent(BRIDGE_ID)}.sqlite`));
  const envelope: Envelope = {
    epochId: "expired-epoch",
    seq: 1,
    event: {
      kind: "state",
      state: {
        nativeId: "private-native-id",
        nativeInstanceId: "main",
        attrs: { state: "private-state-value" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    },
  };
  journal.appendAtomic({ bridgeId: BRIDGE_ID, receivedAt: "2026-08-01T00:00:00.000Z", envelope });
  journal.markConsistent(BRIDGE_ID, { epochId: "expired-epoch", lastSeq: 1 });
  journal.appendAtomic({
    bridgeId: BRIDGE_ID,
    receivedAt: "2026-08-19T00:00:00.000Z",
    envelope: { ...envelope, epochId: "current-epoch" },
  });
  journal.markConsistent(BRIDGE_ID, { epochId: "current-epoch", lastSeq: 1 });
  journal.close();
  new SqliteProposalStore({ path: join(dataDirectory, "proposals.sqlite") }).close();
}

test("defaults to aggregate preview and performs no retention mutation", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-retention-preview-"));
  try {
    seedJournal(dataDirectory);
    const { runHomeRetentionOperation } = await loadOperation();
    const output = await runHomeRetentionOperation(environment(dataDirectory), [], { now: () => NOW });

    assert.deepEqual(output, {
      mode: "preview",
      bridgeId: BRIDGE_ID,
      evidenceWindowStart: "2026-08-13T00:00:00.000Z",
      candidateCount: 1,
      affectedEventCount: 1,
      affectedBytes: output.affectedBytes,
      protectedRecoveryCount: 0,
      protectedHistoryGapCount: 0,
      protectedProposalEvidenceCount: 0,
      protectedEvidenceWindowCount: 1,
      resultingPartialCoverage: true,
    });
    assert.equal(typeof output.affectedBytes === "number" && output.affectedBytes > 0, true);
    assert.equal("policyId" in output, false);
    assert.equal(JSON.stringify(output).includes("private-native-id"), false);
    assert.equal(JSON.stringify(output).includes("private-state-value"), false);

    const reopened = new SqliteIngestJournal(join(dataDirectory, `${encodeURIComponent(BRIDGE_ID)}.sqlite`));
    assert.equal(reopened.records(BRIDGE_ID).length, 2);
    assert.deepEqual(reopened.retentionAudits(BRIDGE_ID), []);
    reopened.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("keeps apply unavailable even with an exact bridge confirmation", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-retention-apply-"));
  try {
    seedJournal(dataDirectory);
    const { runHomeRetentionOperation } = await loadOperation();
    for (const candidateEnvironment of [
      environment(dataDirectory),
      { ...environment(dataDirectory), HOB_RETENTION_CONFIRM_BRIDGE_ID: BRIDGE_ID },
    ]) {
      await assert.rejects(
        runHomeRetentionOperation(candidateEnvironment, ["--apply"], { now: () => NOW }),
        /retention operation/i,
      );
    }

    const reopened = new SqliteIngestJournal(join(dataDirectory, `${encodeURIComponent(BRIDGE_ID)}.sqlite`));
    assert.equal(reopened.records(BRIDGE_ID).length, 2);
    assert.equal(reopened.retentionAudits(BRIDGE_ID).length, 0);
    reopened.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("rejects unknown flags, unconfigured bridges, and confirmation on preview", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-retention-invalid-"));
  try {
    const { runHomeRetentionOperation } = await loadOperation();
    await assert.rejects(
      runHomeRetentionOperation(environment(dataDirectory), ["--unknown"]),
      /retention operation/i,
    );
    await assert.rejects(
      runHomeRetentionOperation({
        ...environment(dataDirectory),
        HOB_RETENTION_BRIDGE_ID: "not-configured",
      }, []),
      /configured bridge/i,
    );
    await assert.rejects(runHomeRetentionOperation({
      ...environment(dataDirectory),
      HOB_RETENTION_CONFIRM_BRIDGE_ID: BRIDGE_ID,
    }, []), /confirmation.*unavailable/i);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
