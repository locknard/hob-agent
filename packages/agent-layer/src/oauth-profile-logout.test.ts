import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DshOAuthProvider } from "./dsh-oauth-seam.js";
import { logoutOAuthProfile } from "./oauth-profile-logout.js";

const profile = {
  id: "claude:household",
  provider: "claude",
  kind: "oauth" as const,
  secretRef: "keychain:hob-agent/claude:household",
};

test("delegates profile-scoped local OAuth logout through the DSH provider seam and removes the vault token", async () => {
  const values: Record<string, string> = {
    "keychain:hob-agent/claude:household": JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: 10_000 }),
  };
  let request: { provider: string; profileId: string; credential?: unknown } | undefined;
  const provider: DshOAuthProvider = {
    login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 10_000 }),
    logout: async (received) => { request = received; },
  };
  await logoutOAuthProfile(profile, {
    read: async (reference) => values[reference],
    write: async (reference, value) => { values[reference] = value; },
    delete: async (reference) => { delete values[reference]; },
  }, provider);

  assert.equal(request?.provider, "anthropic");
  assert.equal(request?.profileId, profile.id);
  assert.deepEqual(request?.credential, {
    type: "oauth", access: "a", refresh: "r", expires: 10_000,
  });
  assert.equal(values["keychain:hob-agent/claude:household"], undefined);
});

test("redacts raw logout failures", async () => {
  await assert.rejects(
    logoutOAuthProfile(profile, {
      read: async () => undefined,
      write: async () => {},
      delete: async () => {},
    }, {
      login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 10_000 }),
      logout: async () => { throw new Error("token=should-not-escape"); },
    }),
    (error: Error) => error.message === "OAuth logout failed for claude",
  );
});

test("does not directly depend on pi-ai", () => {
  const source = readFileSync(new URL("./oauth-profile-logout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@earendil-works\/pi-ai/);
});
