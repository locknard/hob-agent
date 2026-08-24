import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const RUNTIME_OWNER_LEASE_FILENAME = ".hob-agent-runtime-owner.lock" as const;
export const RUNTIME_OWNER_LEASE_BUSY_CODE = "runtime_owner_busy" as const;
export const RUNTIME_OWNER_LEASE_UNSAFE_CODE = "runtime_owner_unsafe" as const;
export const DEFAULT_RUNTIME_OWNER_LEASE_STALE_MS = 60_000;
export const DEFAULT_RUNTIME_OWNER_LEASE_HEARTBEAT_MS = 10_000;

export class RuntimeOwnerLeaseError extends Error {
  constructor(readonly code: typeof RUNTIME_OWNER_LEASE_BUSY_CODE | typeof RUNTIME_OWNER_LEASE_UNSAFE_CODE, message: string) {
    super(message);
    this.name = "RuntimeOwnerLeaseError";
  }
}

export class RuntimeOwnerLeaseBusyError extends RuntimeOwnerLeaseError {
  declare readonly code: typeof RUNTIME_OWNER_LEASE_BUSY_CODE;

  constructor() {
    super(RUNTIME_OWNER_LEASE_BUSY_CODE, "HOB_DATA_DIR is owned by another runtime");
    this.name = "RuntimeOwnerLeaseBusyError";
  }
}

export class RuntimeOwnerLeaseUnsafeError extends RuntimeOwnerLeaseError {
  declare readonly code: typeof RUNTIME_OWNER_LEASE_UNSAFE_CODE;

  constructor() {
    super(RUNTIME_OWNER_LEASE_UNSAFE_CODE, "HOB_DATA_DIR runtime owner lease is unsafe");
    this.name = "RuntimeOwnerLeaseUnsafeError";
  }
}

export interface RuntimeOwnerLeaseOptions {
  /** Age after which an abandoned regular sidecar may be reclaimed. */
  readonly staleAfterMs?: number;
  /** Heartbeat period. Zero disables heartbeats for deterministic tests. */
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
}

export interface RuntimeOwnerLease {
  readonly path: string;
  release(): Promise<void>;
}

interface LeaseIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Acquires the one process-level owner for a private HOB_DATA_DIR. */
export async function acquireRuntimeOwnerLease(
  dataDirectory: string,
  options: RuntimeOwnerLeaseOptions = {},
): Promise<RuntimeOwnerLease> {
  const staleAfterMs = boundedNonNegative(options.staleAfterMs ?? DEFAULT_RUNTIME_OWNER_LEASE_STALE_MS);
  const heartbeatIntervalMs = boundedNonNegative(options.heartbeatIntervalMs ?? DEFAULT_RUNTIME_OWNER_LEASE_HEARTBEAT_MS);
  const now = options.now ?? Date.now;
  const directory = resolve(dataDirectory);
  const path = join(directory, RUNTIME_OWNER_LEASE_FILENAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const owner = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await createLease(path, owner, now);
    if (created !== undefined) return createHandle(path, owner, created.file, created.identity, heartbeatIntervalMs, now);

    const reclaimed = await reclaimStaleLease(path, staleAfterMs, now);
    if (reclaimed === "reclaimed") continue;
    if (reclaimed === "unsafe") throw new RuntimeOwnerLeaseUnsafeError();
    throw new RuntimeOwnerLeaseBusyError();
  }
  throw new RuntimeOwnerLeaseBusyError();
}

async function createLease(
  path: string,
  owner: string,
  now: () => number,
): Promise<{ readonly file: FileHandle; readonly identity: LeaseIdentity } | undefined> {
  let file: FileHandle | undefined;
  let openedIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    file = await open(path, "wx", 0o600);
    await file.chmod(0o600);
    openedIdentity = await file.stat();
    await file.writeFile(JSON.stringify({ version: 1, owner, acquiredAt: finiteNow(now) }), "utf8");
    await file.sync();
    const identity = await file.stat();
    return {
      file,
      identity: {
        device: identity.dev,
        inode: identity.ino,
        size: identity.size,
        mtimeMs: identity.mtimeMs,
      },
    };
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (isErrno(error, "EEXIST")) return undefined;
    if (openedIdentity !== undefined) {
      const createdIdentity = openedIdentity;
      await lstat(path).then((current) => {
        if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
          return unlink(path).catch(() => undefined);
        }
        return undefined;
      }).catch(() => undefined);
    }
    throw error;
  }
}

function createHandle(
  path: string,
  owner: string,
  file: FileHandle,
  identity: LeaseIdentity,
  heartbeatIntervalMs: number,
  now: () => number,
): RuntimeOwnerLease {
  let released = false;
  const heartbeatTimer = heartbeatIntervalMs === 0
    ? undefined
    : setInterval(() => {
        void file.utimes(new Date(finiteNow(now)), new Date(finiteNow(now))).catch(() => undefined);
      }, heartbeatIntervalMs);
  heartbeatTimer?.unref?.();

  return {
    path,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      let failure: unknown;
      try {
        await file.close();
      } catch (error) {
        failure = error;
      }
      try {
        const current = await lstat(path);
        if (sameInode(current, identity) && current.isFile()) {
          let metadata: unknown;
          try {
            metadata = JSON.parse(await readFile(path, "utf8")) as unknown;
          } catch {
            metadata = undefined;
          }
          if (isRecord(metadata) && metadata.owner === owner) await unlink(path);
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}

async function reclaimStaleLease(
  path: string,
  staleAfterMs: number,
  now: () => number,
): Promise<"reclaimed" | "not-stale" | "unsafe"> {
  let observed;
  try {
    observed = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "reclaimed";
    return "unsafe";
  }
  if (!observed.isFile()) return "unsafe";
  if (finiteNow(now) - observed.mtimeMs < staleAfterMs) return "not-stale";

  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "reclaimed";
    return "unsafe";
  }
  if (!sameIdentity(current, observed)) return "unsafe";

  const abandonedPath = `${path}.${randomUUID()}.abandoned`;
  try {
    await rename(path, abandonedPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "reclaimed";
    return "unsafe";
  }
  try {
    const isolated = await lstat(abandonedPath);
    if (!sameIdentity(isolated, observed) || !isolated.isFile()) return "unsafe";
    await unlink(abandonedPath);
    return "reclaimed";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "reclaimed";
    return "unsafe";
  }
}

function sameIdentity(
  value: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number },
  expected: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number },
): boolean {
  return value.dev === expected.dev
    && value.ino === expected.ino
    && value.size === expected.size
    && value.mtimeMs === expected.mtimeMs;
}

function sameInode(value: { readonly dev: number; readonly ino: number }, expected: LeaseIdentity): boolean {
  return value.dev === expected.device && value.ino === expected.inode;
}

function finiteNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new TypeError("Runtime owner lease clock is invalid");
  return value;
}

function boundedNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Runtime owner lease timing is invalid");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value && (value as { code?: unknown }).code === code;
}
