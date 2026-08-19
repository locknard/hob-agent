import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readSecretInput } from "./model-credential-setup.js";

test("reads a piped secret without retaining its trailing line ending", async () => {
  const secret = await readSecretInput(Readable.from(["sk-test", "-value\n"]));
  assert.equal(secret, "sk-test-value");
});

test("rejects empty and unbounded secret input", async () => {
  await assert.rejects(readSecretInput(Readable.from(["\n"])), /must not be empty/);
  await assert.rejects(readSecretInput(Readable.from(["x".repeat(16_385)])), /too long/);
});
