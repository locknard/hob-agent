import assert from "node:assert/strict";
import { chmod, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import test from "node:test";

import {
  OAuthRefreshLockTimeoutError,
  OAuthRefreshLockStaleError,
  acquireOAuthRefreshLock,
  resolveOAuthRefreshLockPath,
} from "./oauth-refresh-lock.js";

async function temporaryLockDir(): Promise<string> {
  const directory = join(tmpdir(), `hob-oauth-refresh-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

test("uses one safe deterministic path for the canonical provider/profile tuple", async () => {
  const directory = await temporaryLockDir();
  const first = resolveOAuthRefreshLockPath("openai", "a/b..\\c\u0000");
  const second = resolveOAuthRefreshLockPath("openai", "a/b..\\c\u0000");
  const differentProvider = resolveOAuthRefreshLockPath("anthropic", "a/b..\\c\u0000");
  const differentTuple = resolveOAuthRefreshLockPath("openai:a", "b");
  assert.equal(first, second);
  assert.notEqual(first, differentProvider);
  assert.notEqual(resolveOAuthRefreshLockPath("a", "b:c"), differentTuple);
  assert.equal(dirname(resolveOAuthRefreshLockPath("openai", "id", directory)), directory);
  assert.match(basename(first), /^lock-[0-9a-f]{64}$/);
});

test("acquires with wx and creates a private lock file that only its owner can release", async () => {
  const directory = await temporaryLockDir();
  const handle = await acquireOAuthRefreshLock("provider", "profile", { directory });
  assert.equal((await stat(handle.lockPath)).mode & 0o777, 0o600);
  await assert.rejects(
    acquireOAuthRefreshLock("provider", "profile", { directory, timeoutMs: 15, retryMs: 1 }),
    (error: unknown) => {
      assert.equal(error instanceof OAuthRefreshLockTimeoutError, true);
      assert.equal((error as { code?: unknown }).code, "oauth_refresh_lock_timeout");
      assert.equal((error as Error).message.includes("provider"), false);
      assert.equal((error as Error).message.includes("profile"), false);
      return true;
    },
  );
  await handle.release();
  await assert.rejects(stat(handle.lockPath), { code: "ENOENT" });
});

test("waits for a configurable retry window and then allows the next owner", async () => {
  const directory = await temporaryLockDir();
  const first = await acquireOAuthRefreshLock("provider", "profile", { directory });
  const waiting = acquireOAuthRefreshLock("provider", "profile", {
    directory,
    timeoutMs: 500,
    retryMs: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await first.release();
  const second = await waiting;
  await second.release();
});

test("reclaims an old lock, but a live lock still times out", async () => {
  const directory = await temporaryLockDir();
  const stalePath = `${resolveOAuthRefreshLockPath("provider", "stale", directory)}.lock`;
  await mkdir(dirname(stalePath), { recursive: true, mode: 0o700 });
  await writeFile(stalePath, JSON.stringify({ owner: "dead", createdAt: 1 }), { flag: "wx", mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(stalePath, old, old);
  const reclaimed = await acquireOAuthRefreshLock("provider", "stale", {
    directory,
    staleMs: 100,
    timeoutMs: 100,
    retryMs: 1,
  });
  await reclaimed.release();

  const live = await acquireOAuthRefreshLock("provider", "live", { directory });
  await assert.rejects(
    acquireOAuthRefreshLock("provider", "live", { directory, staleMs: 60_000, timeoutMs: 10, retryMs: 1 }),
    (error: unknown) => error instanceof OAuthRefreshLockTimeoutError,
  );
  await live.release();
});

test("release never removes a lock file replaced by another owner", async () => {
  const directory = await temporaryLockDir();
  const first = await acquireOAuthRefreshLock("provider", "profile", { directory });
  await chmod(first.lockPath, 0o600);
  await writeFile(first.lockPath, "replacement", { flag: "w", mode: 0o600 });
  await first.release();
  assert.equal((await stat(first.lockPath)).isFile(), true);
});

test("reports stale error when an expired non-file lock cannot be reclaimed", async () => {
  const directory = await temporaryLockDir();
  const lockPath = `${resolveOAuthRefreshLockPath("provider", "directory", directory)}.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await assert.rejects(
    acquireOAuthRefreshLock("provider", "directory", {
      directory,
      staleMs: 0,
      timeoutMs: 5,
      retryMs: 1,
    }),
    (error: unknown) => error instanceof OAuthRefreshLockStaleError && error.code === "oauth_refresh_lock_stale",
  );
});
