import assert from "node:assert/strict";
import test from "node:test";

import { loginOAuthProfile } from "./oauth-profile-login.js";

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

test("delegates profile-scoped Claude OAuth login to pi with a writeable credential store", async () => {
  let providerId: string | undefined;
  let method: string | undefined;
  let storeMetadata: unknown;
  const interaction = { prompt: async () => "", notify: () => {} };

  const credential = await loginOAuthProfile(profile, vault, interaction as never, async (credentials) => {
    storeMetadata = await credentials.list();
    return {
      login: async (provider, type) => {
        providerId = provider;
        method = type;
        return { type: "oauth", access: "access", refresh: "refresh", expires: 10_000 };
      },
    };
  });

  assert.deepEqual(storeMetadata, [{ providerId: "anthropic", type: "oauth" }]);
  assert.deepEqual([providerId, method], ["anthropic", "oauth"]);
  assert.equal(credential.type, "oauth");
});

test("redacts provider login failures at the profile boundary", async () => {
  await assert.rejects(
    loginOAuthProfile(profile, vault, {} as never, async () => ({
      login: async () => { throw new Error("token=should-not-escape"); },
    })),
    (error: Error) => error.message === "OAuth login failed for claude",
  );
});

test("does not reflect an untrusted provider id in the login failure", async () => {
  await assert.rejects(
    loginOAuthProfile({ ...profile, provider: "<untrusted-provider>" }, vault, {} as never),
    (error: Error) => error.message === "OAuth login failed for unsupported provider",
  );
});
