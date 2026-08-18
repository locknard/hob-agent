import assert from "node:assert/strict";
import test from "node:test";

import { providerAdapter } from "./provider-adapters.js";

test("registers provider-specific auth capability without claiming unsupported OAuth", () => {
  assert.deepEqual(providerAdapter("gpt").authMethods, ["api_key"]);
  assert.deepEqual(providerAdapter("claude").authMethods, ["api_key", "oauth", "external_cli"]);
  assert.equal(providerAdapter("claude").oauth?.status, "pi_supported");
  assert.deepEqual(providerAdapter("deepseek").authMethods, ["api_key"]);
  assert.equal(providerAdapter("kimi").oauth, undefined);
  assert.equal(providerAdapter("glm").oauth, undefined);
});
