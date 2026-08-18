import assert from "node:assert/strict";
import test from "node:test";

import { MacOSKeychainSecretVault } from "./macos-keychain-secret-vault.js";

test("reads only a canonical keychain reference without enumerating the keychain", async () => {
  const calls: string[][] = [];
  const vault = new MacOSKeychainSecretVault(async (args) => {
    calls.push([...args]);
    return { ok: true, stdout: "stored-key\n" };
  });

  assert.equal(await vault.read("keychain:hob-agent/gpt:primary"), "stored-key");
  assert.deepEqual(calls, [["find-generic-password", "-s", "hob-agent", "-a", "gpt:primary", "-w"]]);
});

test("writes and removes only the requested canonical keychain item", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const vault = new MacOSKeychainSecretVault(async (args, options) => {
    calls.push({ args: [...args], input: options?.input });
    return { ok: true, stdout: "" };
  });

  await vault.write("keychain:hob-agent/gpt:primary", "key-value");
  await vault.delete("keychain:hob-agent/gpt:primary");

  assert.deepEqual(calls, [
    {
      args: ["add-generic-password", "-U", "-s", "hob-agent", "-a", "gpt:primary", "-w"],
      input: "key-value",
    },
    { args: ["delete-generic-password", "-s", "hob-agent", "-a", "gpt:primary"], input: undefined },
  ]);
});

test("rejects malformed references before invoking the keychain", async () => {
  let calls = 0;
  const vault = new MacOSKeychainSecretVault(async () => {
    calls += 1;
    return { ok: true, stdout: "" };
  });

  await assert.rejects(() => vault.write("keychain:hob-agent", "key-value"), /Invalid keychain secret reference/);
  assert.equal(calls, 0);
});

test("strictly rejects service/account paths, separators, and whitespace before invoking Keychain", async () => {
  let calls = 0;
  const vault = new MacOSKeychainSecretVault(async () => {
    calls += 1;
    return { ok: true, stdout: "" };
  });

  for (const reference of [
    "keychain:hob:agent/gpt:primary",
    "keychain:hob-agent/gpt/primary",
    "keychain:hob-agent/gpt primary",
    "keychain:hob-agent/gpt:primary\n",
    "keychain:../gpt:primary",
  ]) {
    await assert.rejects(() => vault.read(reference), /Invalid keychain secret reference/);
  }
  assert.equal(calls, 0);
});
