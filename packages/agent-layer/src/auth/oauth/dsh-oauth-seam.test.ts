import assert from "node:assert/strict";
import test from "node:test";

import type {
  DshOAuthCredential,
  DshOAuthInteraction,
  DshOAuthProvider,
} from "./dsh-oauth-seam.js";

const credential: DshOAuthCredential = {
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: 10_000,
};

test("defines a provider-neutral DSH OAuth login contract", async () => {
  const interaction: DshOAuthInteraction = {
    prompt: async (prompt) => {
      assert.equal(prompt.type, "manual_code");
      return "code";
    },
    notify: (event) => {
      assert.equal(event.type, "auth_url");
    },
  };
  const calls: string[] = [];
  const provider: DshOAuthProvider = {
    login: async ({ provider, profileId, interaction: received }) => {
      calls.push(`${provider}:${profileId}`);
      received.notify({ type: "auth_url", url: "https://auth.invalid" });
      await received.prompt({ type: "manual_code", message: "Enter code" });
      return credential;
    },
    logout: async ({ provider, profileId }) => {
      calls.push(`logout:${provider}:${profileId}`);
    },
  };

  await provider.login({ provider: "claude", profileId: "claude:household", interaction });
  await provider.logout({ provider: "claude", profileId: "claude:household" });

  assert.deepEqual(calls, ["claude:claude:household", "logout:claude:claude:household"]);
});
