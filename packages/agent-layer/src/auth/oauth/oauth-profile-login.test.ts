import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DshOAuthInteraction, DshOAuthProvider } from "./dsh-oauth-seam.js";
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

test("delegates profile-scoped OAuth login through the DSH provider seam and writes the token", async () => {
  let request: { provider: string; profileId: string; interaction: DshOAuthInteraction } | undefined;
  const writes: string[] = [];
  const interaction: DshOAuthInteraction = { prompt: async () => "", notify: () => {} };
  const provider: DshOAuthProvider = {
    login: async (received) => {
      request = received;
      return { type: "oauth", access: "access", refresh: "refresh", expires: 10_000 };
    },
    logout: async () => {},
  };

  const credential = await loginOAuthProfile({ ...profile }, {
    ...vault,
    write: async (reference, value) => { writes.push(`${reference}:${value}`); },
  }, interaction, provider);

  assert.equal(request?.provider, "anthropic");
  assert.equal(request?.profileId, profile.id);
  assert.equal(request?.interaction, interaction);
  assert.deepEqual(writes, [
    `${profile.secretRef}:${JSON.stringify(credential)}`,
  ]);
  assert.equal(credential.type, "oauth");
});

test("redacts provider login failures at the profile boundary", async () => {
  await assert.rejects(
    loginOAuthProfile(profile, vault, {} as never, {
      login: async () => { throw new Error("token=should-not-escape"); },
      logout: async () => {},
    }),
    (error: Error) => error.message === "OAuth login failed for claude",
  );
});

test("does not reflect an untrusted provider id in the login failure", async () => {
  await assert.rejects(
    loginOAuthProfile({ ...profile, provider: "<untrusted-provider>" }, vault, {} as never, {
      login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 10_000 }),
      logout: async () => {},
    }),
    (error: Error) => error.message === "OAuth login failed for unsupported provider",
  );
});

test("does not directly depend on pi-ai", () => {
  const source = readFileSync(new URL("./oauth-profile-login.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@earendil-works\/pi-ai/);
});
