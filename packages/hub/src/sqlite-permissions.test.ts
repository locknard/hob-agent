import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { IngestRecord } from "@hob/bridge-contract";
import { SqliteBridgeRegistryStore } from "./bridge/bridge-registry-store.js";
import { SqliteIngestJournal } from "./world/ingest-journal.js";
import { WorldModelIndex } from "./world/world-model-index.js";

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function assertPrivateDatabaseFiles(path: string): Promise<void> {
  assert.equal(await mode(path), 0o600);
  assert.equal(await mode(`${path}-wal`), 0o600);
  assert.equal(await mode(`${path}-shm`), 0o600);
}

test("ingest journal keeps the main database and WAL sidecars private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-journal-permissions-"));
  const path = join(directory, "journal.sqlite");
  const journal = new SqliteIngestJournal(path);
  try {
    journal.append({
      bridgeId: "bridge-permissions",
      receivedAt: "2026-08-19T00:00:00.000Z",
      envelope: { epochId: "epoch-a", seq: 1, event: { kind: "heartbeat" } },
    } satisfies IngestRecord);
    await assertPrivateDatabaseFiles(path);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge registry keeps the main database and WAL sidecars private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-registry-permissions-"));
  const path = join(directory, "registry.sqlite");
  const store = new SqliteBridgeRegistryStore(path);
  try {
    store.save({
      bridgeId: "bridge-permissions",
      adapterType: "synthetic",
      createdAt: "2026-08-19T00:00:00.000Z",
      generation: 1,
    });
    await assertPrivateDatabaseFiles(path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("world model keeps the main database and WAL sidecars private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-world-permissions-"));
  const path = join(directory, "world-model.sqlite");
  const index = new WorldModelIndex({ path });
  try {
    index.applyConsistentBatch({
      bridgeId: "bridge-permissions",
      records: [
        {
          bridgeId: "bridge-permissions",
          receivedAt: "2026-08-19T00:00:00.000Z",
          envelope: {
            epochId: "epoch-a",
            seq: 1,
            event: { kind: "sync-start", snapshotId: "snapshot-a", remoteInstanceId: "remote-a", reason: "initial" },
          },
        },
        {
          bridgeId: "bridge-permissions",
          receivedAt: "2026-08-19T00:00:01.000Z",
          envelope: {
            epochId: "epoch-a",
            seq: 2,
            event: {
              kind: "device-upserted",
              device: {
                nativeId: "lamp",
                capabilities: [{ nativeInstanceId: "entity-1", schema: "hob.light", schemaVersion: "1.0.0" }],
              },
            },
          },
        },
        {
          bridgeId: "bridge-permissions",
          receivedAt: "2026-08-19T00:00:02.000Z",
          envelope: {
            epochId: "epoch-a",
            seq: 3,
            event: { kind: "sync-complete", manifest: { snapshotId: "snapshot-a", deviceEnvelopeCount: 1, stateEnvelopeCount: 0 } },
          },
        },
      ],
      consistentWatermark: { epochId: "epoch-a", lastSeq: 3 },
    });
    await assertPrivateDatabaseFiles(path);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
