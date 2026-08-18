import assert from "node:assert/strict";
import test from "node:test";

import {
  createOAuthProfileMetadataSync,
  loginAndRecordOAuthProfile,
  logoutAndRecordOAuthProfile,
} from "./oauth-profile-lifecycle.js";

const profile = {
  id: "claude:household",
  provider: "claude",
  kind: "oauth" as const,
  secretRef: "keychain:hob-agent/claude:household",
};

const vault = {
  read: async () => undefined,
  write: async () => {},
  delete: async () => {},
};

test("records an OAuth profile as needs_auth before login and records its expiry after success", async () => {
  const written: unknown[] = [];
  const result = await loginAndRecordOAuthProfile(profile, vault, {
    upsert: async (next) => { written.push(next); },
  }, {} as never, async () => ({
    login: async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: 10_000 }),
  }));

  assert.deepEqual(result, { ...profile, expiresAt: 10_000 });
  assert.deepEqual(written, [profile, { ...profile, expiresAt: 10_000 }]);
});

test("marks OAuth metadata needs_auth before removing the local token", async () => {
  const operations: string[] = [];
  await logoutAndRecordOAuthProfile({ ...profile, expiresAt: 10_000 }, {
    read: async () => undefined,
    write: async () => {},
    delete: async () => { operations.push("delete-token"); },
  }, {
    upsert: async (next) => { operations.push(next.expiresAt === undefined ? "mark-needs-auth" : "mark-expiry"); },
  }, async (credentials) => ({
    logout: async (provider) => {
      operations.push(`logout-${provider}`);
      await credentials.delete(provider);
    },
  }));

  assert.deepEqual(operations, ["mark-needs-auth", "logout-anthropic", "delete-token"]);
});

test("syncs only OAuth expiry metadata after a credential-store mutation", async () => {
  const written: unknown[] = [];
  const sync = createOAuthProfileMetadataSync({ ...profile, expiresAt: 10_000 }, {
    upsert: async (next) => { written.push(next); },
  });

  await sync.onChanged?.({ expiresAt: 20_000 });
  await sync.onChanged?.({});

  assert.deepEqual(written, [
    { ...profile, expiresAt: 20_000 },
    profile,
  ]);
});
