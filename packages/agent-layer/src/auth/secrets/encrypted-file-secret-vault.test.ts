import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EncryptedFileSecretVault } from "./encrypted-file-secret-vault.js";

const REF = "vault:hob-agent/gpt:primary";
const OTHER_REF = "vault:hob-agent/bridge:home:access-token";

test("persists encrypted entries across restart and atomically overwrites and deletes them", async () => {
  await withVault(async ({ dataDirectory, keyFile }) => {
    const vault = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    await vault.write(REF, "first-secret");
    assert.equal(await vault.read(REF), "first-secret");

    await vault.write(REF, "replacement-secret");
    const restarted = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    assert.equal(await restarted.read(REF), "replacement-secret");

    await restarted.delete(REF);
    assert.equal(await restarted.read(REF), undefined);
    const afterDelete = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    assert.equal(await afterDelete.read(REF), undefined);

    const vaultPath = await findVaultPath(dataDirectory);
    const raw = await readFile(vaultPath, "utf8");
    assert.equal(raw.includes("replacement-secret"), false);
    assert.equal((await stat(vaultPath)).mode & 0o777, 0o600);
  });
});

test("rejects AES-GCM tampering without exposing the secret or filesystem path", async () => {
  await withVault(async ({ dataDirectory, keyFile }) => {
    const vault = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    const secret = "tamper-sensitive-secret";
    await vault.write(REF, secret);
    const vaultPath = await findVaultPath(dataDirectory);
    const state = JSON.parse(await readFile(vaultPath, "utf8")) as { entries: Record<string, { ciphertext: string }> };
    state.entries[REF]!.ciphertext = `A${state.entries[REF]!.ciphertext.slice(1)}`;
    await writeFile(vaultPath, JSON.stringify(state), { mode: 0o600 });

    await assert.rejects(
      () => vault.read(REF),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /encrypted local vault operation failed/i);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(dataDirectory), false);
        return true;
      },
    );
    await assert.rejects(() => vault.write(OTHER_REF, "another-secret"), /encrypted local vault operation failed/i);
  });
});

test("rejects a vault-file symlink instead of following it", async () => {
  await withVault(async ({ dataDirectory, keyFile }) => {
    const vault = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    await vault.write(REF, "symlink-secret");
    const vaultPath = await findVaultPath(dataDirectory);
    const targetPath = join(dataDirectory, "vault-target.json");
    await rename(vaultPath, targetPath);
    await symlink(targetPath, vaultPath);
    await assert.rejects(() => vault.read(REF), /encrypted local vault operation failed/i);
  });
});

test("bounds references and values and fails closed when another writer holds the vault lock", async () => {
  await withVault(async ({ dataDirectory, keyFile }) => {
    const vault = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    await assert.rejects(() => vault.write("vault:hob-agent/invalid ref", "secret"), /encrypted local vault operation failed/i);
    await assert.rejects(() => vault.write(OTHER_REF, "x".repeat(65_537)), /encrypted local vault operation failed/i);

    const vaultPath = join(dataDirectory, "private-secrets.vault.json");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeFile(`${vaultPath}.lock`, "busy", { mode: 0o600 });
    await assert.rejects(() => vault.write(REF, "secret"), /encrypted local vault operation failed/i);
  });
});

test("caps the entry window while allowing replacement of an existing locator", async () => {
  await withVault(async ({ dataDirectory, keyFile }) => {
    const vault = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    const reference = (index: number) => `vault:hob-agent/capacity:${index}`;
    for (let index = 0; index < 256; index += 1) await vault.write(reference(index), `secret-${index}`);
    await vault.write(reference(0), "replacement-secret");
    await assert.rejects(() => vault.write(reference(256), "new-secret"), /encrypted local vault operation failed/i);
    assert.equal(await vault.read(reference(0)), "replacement-secret");
    assert.equal(await vault.read(reference(255)), "secret-255");
    const restarted = await EncryptedFileSecretVault.open({ dataDirectory, keyFile });
    assert.equal(await restarted.read(reference(0)), "replacement-secret");
    assert.equal(await restarted.read(reference(256)), undefined);
  });
});

test("requires an absolute owner-only regular key file with an exact key encoding", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-vault-key-test-"));
  try {
    await assert.rejects(
      () => EncryptedFileSecretVault.open({ dataDirectory, keyFile: "relative-key" }),
      /encrypted local vault key is invalid/i,
    );

    const missingKeyFile = join(dataDirectory, "missing-key");
    await assert.rejects(
      () => EncryptedFileSecretVault.open({ dataDirectory, keyFile: missingKeyFile }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /encrypted local vault key is invalid/i);
        assert.equal(error.message.includes(missingKeyFile), false);
        return true;
      },
    );

    const keyFile = join(dataDirectory, "key");
    await writeFile(keyFile, "too-short", { mode: 0o600 });
    await assert.rejects(() => EncryptedFileSecretVault.open({ dataDirectory, keyFile }), /encrypted local vault key is invalid/i);

    await writeFile(keyFile, "a".repeat(64), { mode: 0o644 });
    await chmod(keyFile, 0o644);
    await assert.rejects(() => EncryptedFileSecretVault.open({ dataDirectory, keyFile }), /encrypted local vault key is invalid/i);

    await writeFile(keyFile, "a".repeat(64), { mode: 0o600 });
    const symlinkPath = join(dataDirectory, "key-link");
    await symlink(keyFile, symlinkPath);
    await assert.rejects(() => EncryptedFileSecretVault.open({ dataDirectory, keyFile: symlinkPath }), /encrypted local vault key is invalid/i);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

async function withVault(callback: (paths: { dataDirectory: string; keyFile: string }) => Promise<void>): Promise<void> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "hob-vault-test-"));
  const keyFile = join(dataDirectory, "vault-key");
  await writeFile(keyFile, "b".repeat(64), { mode: 0o600 });
  try {
    await callback({ dataDirectory, keyFile });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function findVaultPath(dataDirectory: string): Promise<string> {
  const name = (await readdir(dataDirectory)).find((entry) => entry.endsWith(".vault.json"));
  assert(name !== undefined);
  return join(dataDirectory, name);
}
