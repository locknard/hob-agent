import assert from "node:assert/strict";
import test from "node:test";

import { discoverExternalCliProfiles } from "./external-cli-discovery.js";

test("discovers only explicitly scoped external CLI providers without prompting keychain", async () => {
  const calls: unknown[] = [];
  const result = await discoverExternalCliProfiles(["claude"], {
    discover: async (provider, options) => { calls.push([provider, options]); return [{ id: "claude-cli:default", provider, kind: "external_cli" }]; },
  });
  assert.deepEqual(calls, [["claude", { allowKeychainPrompt: false }]]);
  assert.deepEqual(result, [{ id: "claude-cli:default", provider: "claude", kind: "external_cli" }]);
});
