import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireRuntimeOwnerLease,
  RUNTIME_OWNER_LEASE_FILENAME,
  RuntimeOwnerLeaseBusyError,
  RuntimeOwnerLeaseUnsafeError,
} from "./runtime-owner-lease.js";

test("holds one data-directory owner lease and releases only its own sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-runtime-owner-lease-"));
  try {
    const first = await acquireRuntimeOwnerLease(directory, { heartbeatIntervalMs: 0 });
    const sidecar = join(directory, RUNTIME_OWNER_LEASE_FILENAME);
    const metadata = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.version, 1);
    assert.equal(typeof metadata.owner, "string");
    assert.equal(typeof metadata.acquiredAt, "number");
    assert.equal("pid" in metadata, false);
    await assert.rejects(
      acquireRuntimeOwnerLease(directory, { heartbeatIntervalMs: 0 }),
      RuntimeOwnerLeaseBusyError,
    );

    await first.release();
    const second = await acquireRuntimeOwnerLease(directory, { heartbeatIntervalMs: 0 });
    await first.release();
    assert.equal((await lstat(sidecar)).isFile(), true);
    await second.release();
    await assert.rejects(lstat(sidecar), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reclaims one stale regular sidecar without inspecting or terminating a process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-runtime-owner-lease-stale-"));
  const sidecar = join(directory, RUNTIME_OWNER_LEASE_FILENAME);
  try {
    await writeFile(sidecar, JSON.stringify({ version: 1, owner: "abandoned" }), { mode: 0o600 });
    const staleAt = new Date(Date.now() - 10_000);
    await utimes(sidecar, staleAt, staleAt);

    const lease = await acquireRuntimeOwnerLease(directory, {
      staleAfterMs: 100,
      heartbeatIntervalMs: 0,
    });
    assert.equal((await lstat(sidecar)).isFile(), true);
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on an unsafe sidecar instead of reclaiming it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-runtime-owner-lease-unsafe-"));
  const sidecar = join(directory, RUNTIME_OWNER_LEASE_FILENAME);
  try {
    await mkdir(sidecar);
    await assert.rejects(
      acquireRuntimeOwnerLease(directory, { staleAfterMs: 0, heartbeatIntervalMs: 0 }),
      RuntimeOwnerLeaseUnsafeError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
