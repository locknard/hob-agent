import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOAuthProfileCredentialStore } from "./oauth-profile-credential-store.js";
import { OAuthRefreshLockTimeoutError, acquireOAuthRefreshLock } from "./oauth-refresh-lock.js";

function vault(values: Record<string, string> = {}) {
  return {
    values,
    read: async (reference: string) => values[reference],
    write: async (reference: string, value: string) => { values[reference] = value; },
    delete: async (reference: string) => { delete values[reference]; },
  };
}

const profile = {
  id: "claude:household",
  provider: "claude",
  kind: "oauth" as const,
  secretRef: "keychain:hob-agent/claude:household",
};

test("stores a selected OAuth profile in the vault and exposes only pi credential metadata", async () => {
  const secrets = vault();
  const credentials = createOAuthProfileCredentialStore(profile, secrets);

  await credentials.modify("anthropic", async () => ({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 10_000,
  }));

  assert.deepEqual(await credentials.read("anthropic"), {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 10_000,
  });
  assert.deepEqual(await credentials.list(), [{ providerId: "anthropic", type: "oauth" }]);
  assert.equal(await credentials.read("openai"), undefined);
});

test("reports only OAuth expiry metadata after pi refreshes the selected credential", async () => {
  const secrets = vault();
  const changes: Array<{ expiresAt?: number }> = [];
  const credentials = createOAuthProfileCredentialStore(profile, secrets, {
    onChanged: async (change) => { changes.push(change); },
  });

  await credentials.modify("anthropic", async () => ({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 20_000,
  }));

  assert.deepEqual(changes, [{ expiresAt: 20_000 }]);
});

test("reports a missing expiry after pi deletes the selected OAuth credential", async () => {
  const secrets = vault({
    "keychain:hob-agent/claude:household": JSON.stringify({
      type: "oauth", access: "access-token", refresh: "refresh-token", expires: 20_000,
    }),
  });
  const changes: Array<{ expiresAt?: number }> = [];
  const credentials = createOAuthProfileCredentialStore(profile, secrets, {
    onChanged: async (change) => { changes.push(change); },
  });

  await credentials.delete("anthropic");

  assert.deepEqual(changes, [{}]);
});

test("serializes OAuth read-modify-write operations for one selected profile", async () => {
  const secrets = vault({
    "keychain:hob-agent/claude:household": JSON.stringify({
      type: "oauth", access: "old", refresh: "refresh", expires: 1_000,
    }),
  });
  const credentials = createOAuthProfileCredentialStore(profile, secrets);
  let release: () => void;
  let started: () => void;
  const releaseGate = new Promise<void>((resolve) => { release = resolve; });
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  const first = credentials.modify("anthropic", async (current) => {
    assert.equal(current?.type, "oauth");
    started();
    await releaseGate;
    return { type: "oauth", access: "first", refresh: "refresh", expires: 2_000 };
  });
  const second = credentials.modify("anthropic", async (current) => {
    assert.equal((current as { access?: string } | undefined)?.access, "first");
    return { type: "oauth", access: "second", refresh: "refresh", expires: 3_000 };
  });

  await startedGate;
  release();
  await Promise.all([first, second]);
  assert.equal((await credentials.read("anthropic") as { access?: string } | undefined)?.access, "second");
});

test("rejects a profile without a vault reference or a non-OAuth credential mutation", async () => {
  const secrets = vault();
  assert.throws(
    () => createOAuthProfileCredentialStore({ ...profile, secretRef: undefined }, secrets),
    /secret reference/,
  );
  const credentials = createOAuthProfileCredentialStore(profile, secrets);
  await assert.rejects(
    credentials.modify("anthropic", async () => ({ type: "api_key", key: "not-oauth" })),
    /OAuth credential/,
  );
});

test("serializes two store instances so expiry double-check refreshes only once", async () => {
  const secrets = vault({
    "keychain:hob-agent/claude:household": JSON.stringify({
      type: "oauth", access: "expired-access", refresh: "refresh-0", expires: 1,
    }),
  });
  const directory = await mkdtemp(join(tmpdir(), "hob-oauth-store-lock-"));
  const options = { lock: { directory } };
  const first = createOAuthProfileCredentialStore(profile, secrets, options);
  const second = createOAuthProfileCredentialStore(profile, secrets, options);
  let refreshes = 0;

  const refreshIfExpired = async (current: any) => {
    if (!current || current.expires > Date.now()) return undefined;
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { type: "oauth", access: "fresh-access", refresh: "refresh-1", expires: Date.now() + 60_000 };
  };
  await Promise.all([
    first.modify("anthropic", refreshIfExpired),
    second.modify("anthropic", refreshIfExpired),
  ]);

  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(secrets.values[profile.secretRef!]).refresh, "refresh-1");
});

test("serializes modify and delete across store instances", async () => {
  const secrets = vault({
    "keychain:hob-agent/claude:household": JSON.stringify({
      type: "oauth", access: "old", refresh: "refresh-0", expires: 1,
    }),
  });
  const directory = await mkdtemp(join(tmpdir(), "hob-oauth-store-lock-"));
  const first = createOAuthProfileCredentialStore(profile, secrets, { lock: { directory } });
  const second = createOAuthProfileCredentialStore(profile, secrets, { lock: { directory } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const modifying = first.modify("anthropic", async () => {
    await gate;
    return { type: "oauth", access: "new", refresh: "refresh-1", expires: 2 };
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const deleting = second.delete("anthropic");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(secrets.values[profile.secretRef!], undefined);
  release();
  await Promise.all([modifying, deleting]);
  assert.equal(secrets.values[profile.secretRef!], undefined);
});

test("surfaces a stable redacted timeout when the refresh lock is held", async () => {
  const secrets = vault();
  const directory = await mkdtemp(join(tmpdir(), "hob-oauth-store-lock-"));
  const held = await acquireOAuthRefreshLock(profile.provider, profile.id, { directory });
  const store = createOAuthProfileCredentialStore(profile, secrets, {
    lock: { directory, timeoutMs: 10, retryMs: 1 },
  });
  await assert.rejects(
    store.modify("anthropic", async () => ({
      type: "oauth", access: "access-token", refresh: "refresh-token", expires: 2,
    })),
    (error: unknown) => {
      assert.equal(error instanceof OAuthRefreshLockTimeoutError, true);
      assert.equal((error as Error).message, "OAuth refresh lock timed out");
      assert.equal((error as Error).message.includes(profile.provider), false);
      assert.equal((error as Error).message.includes(profile.id), false);
      return true;
    },
  );
  await held.release();
});
