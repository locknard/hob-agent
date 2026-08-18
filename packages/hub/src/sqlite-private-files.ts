import { chmodSync, statSync } from "node:fs";

/** Keeps SQLite's main file and any WAL/SHM sidecars private. */
export function ensurePrivateSqliteFiles(path: string): void {
  if (path === ":memory:" || path.startsWith("file::memory:")) return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
      if ((statSync(candidate).mode & 0o777) !== 0o600) chmodSync(candidate, 0o600);
    } catch (error) {
      // A sidecar may not exist until SQLite first writes to the connection;
      // every other permission/path failure must stop the caller fail-closed.
      if (!isMissingFileError(error)) throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
