import assert from "node:assert/strict";
import test from "node:test";

import { disconnectAuthProfile } from "./auth-profile-disconnect.js";

const profile = {
  id: "gpt:primary",
  provider: "gpt",
  kind: "api_key" as const,
  secretRef: "keychain:hob-agent/gpt:primary",
};

test("disconnects a profile before deleting its scoped secret", async () => {
  const operations: string[] = [];
  await disconnectAuthProfile(profile, {
    remove: async (profileId) => { operations.push(`remove-${profileId}`); },
  }, {
    read: async () => undefined,
    write: async () => {},
    delete: async (reference) => { operations.push(`delete-${reference}`); },
  });

  assert.deepEqual(operations, [
    "remove-gpt:primary",
    "delete-keychain:hob-agent/gpt:primary",
  ]);
});

test("does not restore a disconnected profile when secret cleanup fails", async () => {
  const operations: string[] = [];
  await assert.rejects(
    disconnectAuthProfile(profile, {
      remove: async () => { operations.push("remove"); },
    }, {
      read: async () => undefined,
      write: async () => {},
      delete: async () => {
        operations.push("delete");
        throw new Error("do not expose this Keychain error");
      },
    }),
    (error: Error) => error.message === "Profile disconnected, but secret cleanup needs retry",
  );
  assert.deepEqual(operations, ["remove", "delete"]);
});
