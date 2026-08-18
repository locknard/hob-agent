import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("delegates IngestRecord to the canonical bridge contract", async () => {
  const source = await readFile(new URL("./bridge-ingest-types.ts", import.meta.url), "utf8");

  assert.match(source, /export type \{[\s\S]*\bIngestRecord\b[\s\S]*\} from "\.\.\/\.\.\/\.\.\/contracts\/bridge-contract\.js";/);
  assert.doesNotMatch(source, /export interface IngestRecord/);
});
