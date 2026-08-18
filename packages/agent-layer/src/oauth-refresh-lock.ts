import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FileHandle, mkdir, open, readFile, stat, unlink } from "node:fs/promises";

/** Stable discriminator for exhaustion of the lock acquisition deadline. */
export const OAUTH_REFRESH_LOCK_TIMEOUT_CODE = "oauth_refresh_lock_timeout" as const;

/** Stable discriminator for a lock that could not be safely reclaimed. */
export const OAUTH_REFRESH_LOCK_STALE_CODE = "oauth_refresh_lock_stale" as const;

/** Base class for stable, provider/token-independent lock failures. */
export class OAuthRefreshLockError extends Error {
  readonly code: string;

  constructor(code: string, message: string, name: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/** Error raised when another process holds the lock past the acquisition deadline. */
export class OAuthRefreshLockTimeoutError extends OAuthRefreshLockError {
  declare readonly code: typeof OAUTH_REFRESH_LOCK_TIMEOUT_CODE;

  constructor() {
    super(OAUTH_REFRESH_LOCK_TIMEOUT_CODE, "OAuth refresh lock timed out", "OAuthRefreshLockTimeoutError");
  }
}

/** Error raised when a stale sidecar cannot be inspected or reclaimed safely. */
export class OAuthRefreshLockStaleError extends OAuthRefreshLockError {
  declare readonly code: typeof OAUTH_REFRESH_LOCK_STALE_CODE;

  constructor() {
    super(OAUTH_REFRESH_LOCK_STALE_CODE, "OAuth refresh lock could not be safely reclaimed", "OAuthRefreshLockStaleError");
  }
}

export interface OAuthRefreshLockOptions {
  /** Directory containing the lock sidecars. Defaults to the local hob state directory. */
  directory?: string;
  /** Hard maximum time spent waiting to acquire the lock. */
  timeoutMs?: number;
  /** Delay between failed acquisition attempts. */
  retryMs?: number;
  /** Age after which an abandoned sidecar may be reclaimed. */
  staleMs?: number;
}

export interface OAuthRefreshLockHandle {
  /** Absolute path to the owned sidecar. */
  readonly lockPath: string;
  /** Idempotently releases this handle, never removing another owner's sidecar. */
  release(): Promise<void>;
}

const DEFAULT_DIRECTORY = join(homedir(), ".hob-agent", "locks", "oauth-refresh");
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 180_000;

/**
 * Resolves a bounded, path-safe base name for the canonical `(provider, profileId)` tuple.
 * The digest is only a local lock filename; it contains no provider or credential material.
 */
export function resolveOAuthRefreshLockPath(
  provider: string,
  profileId: string,
  directory = DEFAULT_DIRECTORY,
): string {
  const canonicalKey = JSON.stringify([provider, profileId]);
  const digest = createHash("sha256").update(canonicalKey, "utf8").digest("hex");
  return join(resolve(directory), `lock-${digest}`);
}

/** Acquires the cross-process lock for one provider/profile pair. */
export async function acquireOAuthRefreshLock(
  provider: string,
  profileId: string,
  options: OAuthRefreshLockOptions = {},
): Promise<OAuthRefreshLockHandle> {
  const timeoutMs = nonNegativeFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const retryMs = nonNegativeFinite(options.retryMs ?? DEFAULT_RETRY_MS, DEFAULT_RETRY_MS);
  const staleMs = nonNegativeFinite(options.staleMs ?? DEFAULT_STALE_MS, DEFAULT_STALE_MS);
  const basePath = resolveOAuthRefreshLockPath(provider, profileId, options.directory);
  const lockPath = `${basePath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  const owner = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let unsafeStale = false;
  while (true) {
    let file: FileHandle | undefined;
    try {
      file = await open(lockPath, "wx", 0o600);
      await file.chmod(0o600);
      const identity = await file.stat();
      await file.writeFile(JSON.stringify({ version: 1, owner, createdAt: Date.now() }), "utf8");
      await file.close();
      file = undefined;
      return createHandle(lockPath, owner, identity.dev, identity.ino);
    } catch (error) {
      await closeQuietly(file);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const reclaim = await reclaimStaleLock(lockPath, staleMs);
      if (reclaim === "reclaimed") continue;
      unsafeStale = reclaim === "unsafe";
      if (Date.now() >= deadline) {
        if (unsafeStale) throw new OAuthRefreshLockStaleError();
        throw new OAuthRefreshLockTimeoutError();
      }
      const remaining = deadline - Date.now();
      await delay(Math.min(retryMs, remaining));
    }
  }
}

/** Runs a callback while holding one provider/profile lock. */
export async function withOAuthRefreshLock<T>(
  provider: string,
  profileId: string,
  options: OAuthRefreshLockOptions,
  task: () => Promise<T>,
): Promise<T> {
  const handle = await acquireOAuthRefreshLock(provider, profileId, options);
  try {
    return await task();
  } finally {
    await handle.release();
  }
}

function createHandle(
  lockPath: string,
  owner: string,
  device: number,
  inode: number,
): OAuthRefreshLockHandle {
  let released = false;
  return {
    lockPath,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const current = await stat(lockPath);
        if (current.dev !== device || current.ino !== inode || !current.isFile()) return;
        let payload: unknown;
        try {
          payload = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
        } catch {
          return;
        }
        if (!isRecord(payload) || payload.owner !== owner) return;
        await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

async function reclaimStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<"reclaimed" | "not-stale" | "unsafe"> {
  let observed;
  try {
    observed = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "reclaimed";
    return "unsafe";
  }
  if (Date.now() - observed.mtimeMs < staleMs) return "not-stale";
  if (!observed.isFile()) return "unsafe";
  try {
    const current = await stat(lockPath);
    if (
      !current.isFile() ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs ||
      current.size !== observed.size
    ) return "unsafe";
    await unlink(lockPath);
    return "reclaimed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "reclaimed";
    return "unsafe";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function closeQuietly(file: FileHandle | undefined): Promise<void> {
  if (file === undefined) return;
  await file.close().catch(() => undefined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
