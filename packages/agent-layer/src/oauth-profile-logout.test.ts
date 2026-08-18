import assert from "node:assert/strict";
import test from "node:test";

import { logoutOAuthProfile } from "./oauth-profile-logout.js";

const profile = {
  id: "claude:household",
  provider: "claude",
  kind: "oauth" as const,
  secretRef: "keychain:hob-agent/claude:household",
};

test("delegates profile-scoped local OAuth logout to pi and removes the vault token", async () => {
  const values: Record<string, string> = {
    "keychain:hob-agent/claude:household": JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: 10_000 }),
  };
  let providerId: string | undefined;
  await logoutOAuthProfile(profile, {
    read: async (reference) => values[reference],
    write: async (reference, value) => { values[reference] = value; },
    delete: async (reference) => { delete values[reference]; },
  }, async (credentials) => ({
    logout: async (provider) => {
      providerId = provider;
      await credentials.delete(provider);
    },
  }));

  assert.equal(providerId, "anthropic");
  assert.equal(values["keychain:hob-agent/claude:household"], undefined);
});

test("redacts raw logout failures", async () => {
  await assert.rejects(
    logoutOAuthProfile(profile, {
      read: async () => undefined,
      write: async () => {},
      delete: async () => {},
    }, async () => ({ logout: async () => { throw new Error("token=should-not-escape"); } })),
    (error: Error) => error.message === "OAuth logout failed for claude",
  );
});
