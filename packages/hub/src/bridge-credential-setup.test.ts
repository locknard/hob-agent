import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { setupBridgeCredential } from "./bridge-credential-setup.js";

test("writes one explicitly scoped bridge secret without returning the value", async () => {
  const writes: Array<[string, string]> = [];
  const result = await setupBridgeCredential({
    HOB_BRIDGE_ID: "ha-main",
    HOB_BRIDGE_CREDENTIAL_ALIAS: "access-token",
  }, Readable.from(["home-assistant-secret\n"]), {
    read: async () => undefined,
    write: async (reference, value) => { writes.push([reference, value]); },
    delete: async () => undefined,
  });

  assert.deepEqual(result, {
    bridgeId: "ha-main",
    alias: "access-token",
    credentialRef: "keychain:hob-agent/bridge:ha-main:access-token",
    status: "configured",
  });
  assert.deepEqual(writes, [[
    "keychain:hob-agent/bridge:ha-main:access-token",
    "home-assistant-secret",
  ]]);
  assert.equal(JSON.stringify(result).includes("home-assistant-secret"), false);
});

test("rejects bridge credential scopes that cannot form the canonical locator", async () => {
  for (const environment of [
    { HOB_BRIDGE_ID: "../other", HOB_BRIDGE_CREDENTIAL_ALIAS: "access-token" },
    { HOB_BRIDGE_ID: "ha-main", HOB_BRIDGE_CREDENTIAL_ALIAS: "other/token" },
  ]) {
    await assert.rejects(
      setupBridgeCredential(environment, Readable.from(["secret\n"]), {
        read: async () => undefined,
        write: async () => undefined,
        delete: async () => undefined,
      }),
      /HOB_BRIDGE/,
    );
  }
});
