import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

test("ignores ENOENT for a database that has not been created yet", () => {
  const path = join(tmpdir(), `hob-private-missing-${process.pid}-${Date.now()}`);
  assert.doesNotThrow(() => ensurePrivateSqliteFiles(path));
});

test("propagates non-ENOENT permission/path failures", () => {
  assert.throws(
    () => ensurePrivateSqliteFiles(`${tmpdir()}\u0000invalid`),
    (error: unknown) => error instanceof TypeError,
  );
});
