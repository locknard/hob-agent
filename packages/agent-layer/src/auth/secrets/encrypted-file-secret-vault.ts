import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { parseSecretRef } from "./secret-ref.js";
import type { WritableSecretVault } from "./secret-vault.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_FILE_BYTES = 128;
const MAX_REFERENCE_BYTES = 512;
const MAX_SECRET_BYTES = 65_536;
const MAX_ENTRIES = 256;
const MAX_VAULT_FILE_BYTES = 256 * 1024;
const VAULT_VERSION = 1;
const VAULT_FILE_NAME = "private-secrets.vault.json";
const NOFOLLOW_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export interface EncryptedFileSecretVaultOptions {
  readonly dataDirectory: string;
  readonly keyFile: string;
}

interface StoredVaultEntry {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface StoredVault {
  readonly version: typeof VAULT_VERSION;
  readonly entries: Readonly<Record<string, StoredVaultEntry>>;
  readonly integrity: string;
}

/**
 * A bounded, authenticated local credential store for hosts without Keychain.
 * The key is held only in this process and is never serialized into the vault.
 */
export class EncryptedFileSecretVault implements WritableSecretVault {
  private readonly vaultPath: string;
  private readonly lockPath: string;
  private mutation: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dataDirectory: string,
    private readonly key: Buffer,
  ) {
    this.vaultPath = join(dataDirectory, VAULT_FILE_NAME);
    this.lockPath = `${this.vaultPath}.lock`;
  }

  /** Opens a vault only after validating the explicit operator-managed key file. */
  static async open(options: EncryptedFileSecretVaultOptions): Promise<EncryptedFileSecretVault> {
    const dataDirectory = validateDataDirectory(options.dataDirectory);
    const key = await loadVaultKey(options.keyFile);
    const vault = new EncryptedFileSecretVault(dataDirectory, key);
    try {
      await vault.ensureDirectory();
    } catch {
      throw vaultOperationError();
    }
    return vault;
  }

  async read(reference: string): Promise<string | undefined> {
    const canonicalReference = validatedReference(reference);
    try {
      const stored = await this.readStored();
      const entry = stored.entries[canonicalReference];
      if (entry === undefined) return undefined;
      return decryptSecret(this.key, canonicalReference, entry);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw vaultOperationError();
    }
  }

  async write(reference: string, value: string): Promise<void> {
    const canonicalReference = validatedReference(reference);
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw vaultOperationError();
    }
    return this.mutate(async () => {
      try {
        await this.ensureDirectory();
        await this.withWriteLock(async () => {
          const stored = await this.readStored(true);
          if (!(canonicalReference in stored.entries) && Object.keys(stored.entries).length >= MAX_ENTRIES) {
            throw new Error("vault entry window is full");
          }
          const entries = { ...stored.entries, [canonicalReference]: encryptSecret(this.key, canonicalReference, value) };
          await this.writeStored(createStoredVault(this.key, entries));
        });
      } catch {
        throw vaultOperationError();
      }
    });
  }

  async delete(reference: string): Promise<void> {
    const canonicalReference = validatedReference(reference);
    return this.mutate(async () => {
      try {
        await this.ensureDirectory();
        await this.withWriteLock(async () => {
          const stored = await this.readStored(true);
          if (!(canonicalReference in stored.entries)) return;
          const entries = { ...stored.entries };
          delete entries[canonicalReference];
          await this.writeStored(createStoredVault(this.key, entries));
        });
      } catch {
        throw vaultOperationError();
      }
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutation;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    let lock: FileHandle | undefined;
    const owner = randomUUID();
    try {
      lock = await open(this.lockPath, "wx", 0o600);
      await lock.writeFile(owner, "utf8");
      await lock.sync();
    } catch {
      await lock?.close().catch(() => undefined);
      try {
        if (await readFile(this.lockPath, "utf8") === owner) await unlink(this.lockPath);
      } catch {
        // Leave an uncertain lock in place so a later writer fails closed.
      }
      throw vaultOperationError();
    }
    if (lock === undefined) throw vaultOperationError();
    try {
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      try {
        if (await readFile(this.lockPath, "utf8") === owner) await unlink(this.lockPath);
      } catch {
        // A missing or replaced lock remains fail-closed for the next writer.
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const existing = await lstat(this.dataDirectory);
      if (!existing.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    }
    await chmod(this.dataDirectory, 0o700);
  }

  private async readStored(authenticateEntries = false): Promise<StoredVault> {
    let file: FileHandle;
    try {
      file = await open(this.vaultPath, NOFOLLOW_READ_FLAGS);
    } catch (error) {
      if (isMissingFile(error)) return createStoredVault(this.key, {});
      throw error;
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0 || metadata.size > MAX_VAULT_FILE_BYTES) {
        throw new Error("invalid vault file");
      }
      const source = await file.readFile("utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_VAULT_FILE_BYTES) throw new Error("vault file is too large");
      const stored = parseStoredVault(source, this.key);
      if (authenticateEntries) {
        for (const [reference, entry] of Object.entries(stored.entries)) decryptSecret(this.key, reference, entry);
      }
      return stored;
    } finally {
      await file.close();
    }
  }

  private async writeStored(stored: StoredVault): Promise<void> {
    const source = JSON.stringify(stored);
    if (Buffer.byteLength(source, "utf8") > MAX_VAULT_FILE_BYTES) throw new Error("vault file is too large");
    const temporaryPath = `${this.vaultPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(source, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.vaultPath);
      const directory = await open(this.dataDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function openEncryptedFileSecretVault(
  options: EncryptedFileSecretVaultOptions,
): Promise<EncryptedFileSecretVault> {
  return EncryptedFileSecretVault.open(options);
}

export const createEncryptedFileSecretVault = openEncryptedFileSecretVault;

function validateDataDirectory(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\u0000")) {
    throw vaultOperationError();
  }
  return value;
}

async function loadVaultKey(value: unknown): Promise<Buffer> {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\u0000")) throw vaultKeyError();
  let file: FileHandle | undefined;
  try {
    file = await open(value, NOFOLLOW_READ_FLAGS);
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0 || metadata.size > MAX_KEY_FILE_BYTES) {
      throw vaultKeyError();
    }
    const source = await file.readFile();
    const key = decodeKey(source);
    if (key === undefined) throw vaultKeyError();
    return key;
  } catch (error) {
    if (error instanceof Error && error.message === "Encrypted local vault key is invalid") throw error;
    throw vaultKeyError();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function decodeKey(source: Buffer): Buffer | undefined {
  if (source.length === KEY_BYTES) return Buffer.from(source);
  let text = source.toString("utf8");
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return Buffer.from(text, "hex");
  if (!/^[A-Za-z0-9+/]{43}={0,1}$/u.test(text)) return undefined;
  const key = Buffer.from(text, "base64");
  return key.length === KEY_BYTES && key.toString("base64") === text ? key : undefined;
}

function validatedReference(reference: unknown): string {
  try {
    const parsed = parseSecretRef(reference);
    if (parsed.source !== "vault" || Buffer.byteLength(reference as string, "utf8") > MAX_REFERENCE_BYTES) throw new Error();
    return `vault:${parsed.id}`;
  } catch {
    throw vaultOperationError();
  }
}

function encryptSecret(key: Buffer, reference: string, value: string): StoredVaultEntry {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(reference, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSecret(key: Buffer, reference: string, entry: StoredVaultEntry): string {
  const iv = decodeBase64(entry.iv, IV_BYTES);
  const tag = decodeBase64(entry.tag, TAG_BYTES);
  const ciphertext = decodeBase64(entry.ciphertext);
  if (ciphertext.length === 0 || ciphertext.length > MAX_SECRET_BYTES) throw new Error("invalid encrypted value");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(reference, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const value = plaintext.toString("utf8");
  if (Buffer.from(value, "utf8").compare(plaintext) !== 0 || value.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
    throw new Error("invalid encrypted value");
  }
  return value;
}

function parseStoredVault(source: string, key: Buffer): StoredVault {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("invalid vault json");
  }
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.version !== VAULT_VERSION
    || !isRecord(value.entries) || typeof value.integrity !== "string") {
    throw new Error("invalid vault shape");
  }
  const entries: Record<string, StoredVaultEntry> = {};
  const rawEntries = Object.entries(value.entries);
  if (rawEntries.length > MAX_ENTRIES) throw new Error("vault has too many entries");
  for (const [reference, entry] of rawEntries) {
    const canonical = validatedReference(reference);
    if (canonical !== reference || !isRecord(entry)
      || Object.keys(entry).length !== 3
      || typeof entry.iv !== "string" || typeof entry.tag !== "string" || typeof entry.ciphertext !== "string") {
      throw new Error("invalid vault entry");
    }
    decodeBase64(entry.iv, IV_BYTES);
    decodeBase64(entry.tag, TAG_BYTES);
    const ciphertext = decodeBase64(entry.ciphertext);
    if (ciphertext.length === 0 || ciphertext.length > MAX_SECRET_BYTES) throw new Error("invalid encrypted value");
    entries[canonical] = Object.freeze({ iv: entry.iv, tag: entry.tag, ciphertext: entry.ciphertext });
  }
  const actualIntegrity = decodeBase64(value.integrity, 32);
  const expectedIntegrity = createIntegrity(key, entries);
  if (actualIntegrity.length !== expectedIntegrity.length || !timingSafeEqual(actualIntegrity, expectedIntegrity)) {
    throw new Error("invalid vault integrity");
  }
  return Object.freeze({ version: VAULT_VERSION, entries: Object.freeze(entries), integrity: value.integrity });
}

function createStoredVault(key: Buffer, entries: Readonly<Record<string, StoredVaultEntry>>): StoredVault {
  return Object.freeze({
    version: VAULT_VERSION,
    entries: Object.freeze({ ...entries }),
    integrity: createIntegrity(key, entries).toString("base64"),
  });
}

function createIntegrity(key: Buffer, entries: Readonly<Record<string, StoredVaultEntry>>): Buffer {
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
  return createHmac("sha256", key).update(canonical, "utf8").digest();
}

function decodeBase64(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) throw new Error("invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new Error("invalid base64 length");
  if (decoded.toString("base64") !== value) throw new Error("invalid base64 encoding");
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function vaultOperationError(): Error {
  return new Error("Encrypted local vault operation failed");
}

function vaultKeyError(): Error {
  return new Error("Encrypted local vault key is invalid");
}
