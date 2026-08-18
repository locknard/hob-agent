import assert from "node:assert/strict";
import test from "node:test";

import { probeProvider } from "./provider-probe.js";

test("reports minimal probe success without retaining provider response", async () => {
  const result = await probeProvider("gpt/gpt-5.4", async () => ({ ignored: "provider output" }), () => 100);
  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "ok", latencyMs: 0 });
});

test("classifies probe failure without retaining raw error details", async () => {
  const result = await probeProvider("gpt/gpt-5.4", async () => { throw new Error("401 invalid api key: secret"); }, (() => { let time = 0; return () => (time += 10); })());
  assert.deepEqual(result, { model: "gpt/gpt-5.4", status: "auth", latencyMs: 10 });
});
