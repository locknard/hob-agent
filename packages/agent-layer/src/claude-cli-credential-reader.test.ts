import assert from "node:assert/strict";
import test from "node:test";

import { FileClaudeCliCredentialReader, parseClaudeCliOAuthCredential } from "./claude-cli-credential-reader.js";

test("parses only a complete Claude CLI OAuth credential", () => {
  assert.deepEqual(parseClaudeCliOAuthCredential({
    claudeAiOauth: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 10_000,
    },
  }), {
    access: "access",
    refresh: "refresh",
    expires: 10_000,
  });
  assert.equal(parseClaudeCliOAuthCredential({ claudeAiOauth: { accessToken: "access", expiresAt: 10_000 } }), undefined);
});

test("reads only the configured Claude credential file and treats unreadable data as unavailable", async () => {
  const paths: string[] = [];
  const reader = new FileClaudeCliCredentialReader("/private/claude-credentials.json", async (path) => {
    paths.push(path);
    return JSON.stringify({ claudeAiOauth: { accessToken: "access", refreshToken: "refresh", expiresAt: 10_000 } });
  });
  assert.deepEqual(await reader.read(), { access: "access", refresh: "refresh", expires: 10_000 });
  assert.deepEqual(paths, ["/private/claude-credentials.json"]);

  const unreadable = new FileClaudeCliCredentialReader("/private/claude-credentials.json", async () => { throw new Error("denied"); });
  assert.equal(await unreadable.read(), undefined);
});
