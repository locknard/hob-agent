import assert from "node:assert/strict";
import test from "node:test";

import { provisionApiKeyProfile } from "./api-key-profile-provisioner.js";

test("stores an API key in the vault while metadata receives no secret value", async () => {
  const written: Array<[string, string]> = [];
  const metadata: unknown[] = [];
  const vault = {
    read: async () => undefined,
    write: async (reference: string, value: string) => { written.push([reference, value]); },
    delete: async () => {},
  };

  await provisionApiKeyProfile(vault, { upsert: (profile) => { metadata.push(profile); } }, {
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    secretRef: "keychain:hob-agent/gpt:primary",
  }, "api-key-value");

  assert.deepEqual(written, [["keychain:hob-agent/gpt:primary", "api-key-value"]]);
  assert.deepEqual(metadata, [{
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    secretRef: "keychain:hob-agent/gpt:primary",
  }]);
});

test("removes the just-written secret if profile metadata persistence fails", async () => {
  const deleted: string[] = [];
  const vault = {
    read: async () => undefined,
    write: async () => {},
    delete: async (reference: string) => { deleted.push(reference); },
  };

  await assert.rejects(
    provisionApiKeyProfile(vault, { upsert: () => { throw new Error("database unavailable"); } }, {
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key",
      secretRef: "keychain:hob-agent/gpt:primary",
    }, "api-key-value"),
    /database unavailable/,
  );
  assert.deepEqual(deleted, ["keychain:hob-agent/gpt:primary"]);
});

test("restores a prior secret rather than deleting it when metadata persistence fails", async () => {
  const writes: string[] = [];
  const deleted: string[] = [];
  const vault = {
    read: async () => "previous-key",
    write: async (_reference: string, value: string) => { writes.push(value); },
    delete: async (reference: string) => { deleted.push(reference); },
  };

  await assert.rejects(
    provisionApiKeyProfile(vault, { upsert: () => { throw new Error("database unavailable"); } }, {
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key",
      secretRef: "keychain:hob-agent/gpt:primary",
    }, "replacement-key"),
    /database unavailable/,
  );
  assert.deepEqual(writes, ["replacement-key", "previous-key"]);
  assert.deepEqual(deleted, []);
});
