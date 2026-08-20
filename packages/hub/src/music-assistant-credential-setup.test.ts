import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MUSIC_ASSISTANT_ENV_CREDENTIAL_REF,
  MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF,
  parseMusicAssistantCredentialRef,
  setupMusicAssistantCredential,
} from "./music-assistant-credential-setup.js";

test("writes the Music Assistant token to the fixed Keychain scope and returns metadata only", async () => {
  const token = "music-assistant-private-token";
  const writes: Array<[string, string]> = [];

  const result = await setupMusicAssistantCredential(
    {},
    Readable.from([`${token}\n`]),
    {
      read: async () => undefined,
      write: async (reference, value) => { writes.push([reference, value]); },
      delete: async () => undefined,
    },
  );

  assert.deepEqual(result, {
    provider: "music-assistant",
    credentialRef: MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF,
    status: "configured",
  });
  assert.deepEqual(writes, [[MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF, token]]);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("accepts only the exact Music Assistant Keychain or development env reference", () => {
  assert.equal(
    parseMusicAssistantCredentialRef(MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF),
    MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF,
  );
  assert.equal(
    parseMusicAssistantCredentialRef(MUSIC_ASSISTANT_ENV_CREDENTIAL_REF),
    MUSIC_ASSISTANT_ENV_CREDENTIAL_REF,
  );

  for (const value of [
    "keychain:hob-agent/media:other:access-token",
    "keychain:hob-agent/bridge:music-assistant:access-token",
    "env:HOB_OTHER_TOKEN",
    "env:hob_music_assistant_token",
    "music-assistant-private-token",
  ]) {
    assert.throws(
      () => parseMusicAssistantCredentialRef(value),
      (error: unknown) => error instanceof Error
        && /Music Assistant credential reference/.test(error.message)
        && !error.message.includes(value),
    );
  }
});

test("does not auto-discover a raw environment token or write it to config", async () => {
  const rawToken = "raw-environment-token-must-not-be-used";
  const writes: Array<[string, string]> = [];

  const result = await setupMusicAssistantCredential(
    { HOB_MUSIC_ASSISTANT_TOKEN: rawToken },
    Readable.from(["stdin-token\n"]),
    {
      read: async () => undefined,
      write: async (reference, value) => { writes.push([reference, value]); },
      delete: async () => undefined,
    },
  );

  assert.equal(JSON.stringify(result).includes(rawToken), false);
  assert.deepEqual(writes, [[MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF, "stdin-token"]]);
});

test("rejects an empty token before touching the vault", async () => {
  let writes = 0;
  await assert.rejects(
    setupMusicAssistantCredential({}, Readable.from(["\n"]), {
      read: async () => undefined,
      write: async () => { writes += 1; },
      delete: async () => undefined,
    }),
    /Credential must not be empty/,
  );
  assert.equal(writes, 0);
});

test("redacts a vault write failure instead of propagating a token-bearing error", async () => {
  const token = "token-must-not-appear-in-error";
  await assert.rejects(
    setupMusicAssistantCredential({}, Readable.from([`${token}\n`]), {
      read: async () => undefined,
      write: async () => { throw new Error(`Keychain rejected ${token}`); },
      delete: async () => undefined,
    }),
    (error: unknown) => error instanceof Error
      && /Music Assistant credential storage failed/.test(error.message)
      && !error.message.includes(token),
  );
});
