import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const SESSION_VERSION = "hob.product-session/v1" as const;
const MAX_SESSION_BYTES = 4_096;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface StoredProductSession {
  readonly version: typeof SESSION_VERSION;
  readonly tokenDigest: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProductOperationalSession {
  readonly principalId: string;
  readonly deviceId: string;
}

/**
 * Durable owner for the one browser session that activates the local household
 * product. Its file contains a token digest and pairing metadata only.
 */
export class ProductSessionStore {
  private readonly path: string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(directory, "product-session.json");
  }

  create(input: {
    readonly token: string;
    readonly principalId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<ProductOperationalSession> {
    return this.exclusive(async () => {
      const token = sessionToken(input.token);
      const expiresAt = validFutureDate(input.expiresAt, this.now());
      const stored: StoredProductSession = Object.freeze({
        version: SESSION_VERSION,
        tokenDigest: digest(token),
        principalId: identifier(input.principalId, "Product session principal"),
        deviceId: identifier(input.deviceId, "Product session device"),
        issuedAt: this.now().toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      await this.createStored(stored);
      return projection(stored);
    });
  }

  /** Replaces the durable browser token while retaining the one household binding. */
  rotate(input: {
    readonly token: string;
    readonly expiresAt: Date;
  }): Promise<ProductOperationalSession> {
    return this.exclusive(async () => {
      const current = await this.loadStored();
      if (current === undefined) throw new Error("Product operational session is unavailable");
      const token = sessionToken(input.token);
      const expiresAt = validFutureDate(input.expiresAt, this.now());
      const stored: StoredProductSession = Object.freeze({
        version: SESSION_VERSION,
        tokenDigest: digest(token),
        principalId: current.principalId,
        deviceId: current.deviceId,
        issuedAt: this.now().toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      await this.writeStored(stored);
      return projection(stored);
    });
  }

  async authenticate(token: string): Promise<ProductOperationalSession | undefined> {
    const stored = await this.loadStored();
    if (stored === undefined || this.now().getTime() >= Date.parse(stored.expiresAt)) return undefined;
    if (!isSessionToken(token)) return undefined;
    const actual = Buffer.from(digest(token), "hex");
    const expected = Buffer.from(stored.tokenDigest, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? projection(stored)
      : undefined;
  }

  /** Removes only the exact session created for a failed activation attempt. */
  remove(token: string): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.loadStored();
      if (stored === undefined || !sameDigest(stored.tokenDigest, sessionToken(token))) return;
      await unlink(this.path).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    });
  }

  /** Removes a session before the supervisor reopens the household setup flow. */
  clearForSetup(): Promise<void> {
    return this.exclusive(async () => {
      await unlink(this.path).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    });
  }

  private async loadStored(): Promise<StoredProductSession | undefined> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SESSION_BYTES) throw new Error("Product session exceeds its size limit");
    return validateStored(JSON.parse(source) as unknown);
  }

  private async writeStored(stored: StoredProductSession): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temporaryPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    }
  }

  /** Creates the one durable session file without replacing a concurrent owner. */
  private async createStored(stored: StoredProductSession): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    let created = false;
    try {
      const file = await open(this.path, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(this.path, 0o600);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new Error("Product operational session already exists");
      if (created) await unlink(this.path).catch((unlinkError) => { if (!isErrno(unlinkError, "ENOENT")) throw unlinkError; });
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations;
    let release: (() => void) | undefined;
    this.mutations = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function validateStored(value: unknown): StoredProductSession {
  if (!isRecord(value) || value.version !== SESSION_VERSION || Object.keys(value).some((key) => ![
    "version", "tokenDigest", "principalId", "deviceId", "issuedAt", "expiresAt",
  ].includes(key))) throw new Error("Product session header is invalid");
  if (typeof value.tokenDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.tokenDigest)) {
    throw new Error("Product session digest is invalid");
  }
  const issuedAt = validDate(value.issuedAt, "Product session issue time");
  const expiresAt = validDate(value.expiresAt, "Product session expiry");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("Product session expiry is invalid");
  return Object.freeze({
    version: SESSION_VERSION,
    tokenDigest: value.tokenDigest,
    principalId: identifier(value.principalId, "Product session principal"),
    deviceId: identifier(value.deviceId, "Product session device"),
    issuedAt,
    expiresAt,
  });
}

function projection(stored: StoredProductSession): ProductOperationalSession {
  return Object.freeze({ principalId: stored.principalId, deviceId: stored.deviceId });
}

function sessionToken(value: string): string {
  if (!isSessionToken(value)) throw new TypeError("Product session token is invalid");
  return value;
}

function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 512;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function validFutureDate(value: Date, now: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= now.getTime()) {
    throw new TypeError("Product session expiry is invalid");
  }
  return value;
}

function validDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameDigest(expected: string, token: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(digest(token), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
