import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCliExternalDiscoverer } from "./claude-cli-external-discoverer.js";

test("discovers a non-secret Claude CLI profile only for Claude and only while usable", async () => {
  let reads = 0;
  const discoverer = new ClaudeCliExternalDiscoverer({
    read: async () => {
      reads += 1;
      return { access: "access", refresh: "refresh", expires: 10_000 };
    },
  }, () => 1_000);

  assert.deepEqual(await discoverer.discover("claude", { allowKeychainPrompt: false }), [{
    id: "claude-cli:default",
    provider: "claude",
    kind: "external_cli",
  }]);
  assert.deepEqual(await discoverer.discover("gpt", { allowKeychainPrompt: false }), []);
  assert.equal(reads, 1);
});

test("does not report an expired or unreadable Claude CLI credential", async () => {
  const expired = new ClaudeCliExternalDiscoverer({
    read: async () => ({ access: "access", refresh: "refresh", expires: 999 }),
  }, () => 1_000);
  assert.deepEqual(await expired.discover("claude", { allowKeychainPrompt: false }), []);
});
