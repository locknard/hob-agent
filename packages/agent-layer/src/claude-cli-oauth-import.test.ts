import assert from "node:assert/strict";
import test from "node:test";

import { importClaudeCliOAuthCredential } from "./claude-cli-oauth-import.js";

const profile = {
  id: "claude:household",
  provider: "claude",
  kind: "oauth" as const,
  secretRef: "keychain:hob-agent/claude:household",
};

function vault(values: Record<string, string> = {}) {
  return {
    values,
    read: async (reference: string) => values[reference],
    write: async (reference: string, value: string) => { values[reference] = value; },
    delete: async (reference: string) => { delete values[reference]; },
  };
}

test("imports a usable Claude CLI credential only after explicit invocation", async () => {
  const secrets = vault();
  const result = await importClaudeCliOAuthCredential(profile, {
    read: async () => ({ access: "cli-access", refresh: "cli-refresh", expires: 10_000 }),
  }, secrets, { upsert: async () => {} }, 1_000);

  assert.deepEqual(result, { imported: true, expiresAt: 10_000 });
  assert.match(secrets.values["keychain:hob-agent/claude:household"] ?? "", /cli-access/);
});

test("refuses to overwrite a healthy local OAuth credential with a CLI import", async () => {
  const secrets = vault({
    "keychain:hob-agent/claude:household": JSON.stringify({
      type: "oauth", access: "local", refresh: "local-refresh", expires: 10_000,
    }),
  });

  await assert.rejects(
    importClaudeCliOAuthCredential(profile, {
      read: async () => ({ access: "cli-access", refresh: "cli-refresh", expires: 20_000 }),
    }, secrets, { upsert: async () => {} }, 1_000),
    /healthy local OAuth credential/,
  );
});

test("refuses an expired or unavailable Claude CLI credential", async () => {
  await assert.rejects(
    importClaudeCliOAuthCredential(profile, { read: async () => undefined }, vault(), { upsert: async () => {} }, 1_000),
    /No usable Claude CLI credential/,
  );
});

test("records only the imported Claude OAuth expiry in profile metadata", async () => {
  const written: unknown[] = [];
  await importClaudeCliOAuthCredential(profile, {
    read: async () => ({ access: "cli-access", refresh: "cli-refresh", expires: 10_000 }),
  }, vault(), {
    upsert: async (next) => { written.push(next); },
  }, 1_000);

  assert.deepEqual(written, [{ ...profile, expiresAt: 10_000 }]);
});
