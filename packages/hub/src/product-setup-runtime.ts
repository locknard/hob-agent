import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { ProductSetupHttpService } from "@hob-agent/inbox-web/setup";
import { ProductHttpHost } from "@hob-agent/inbox-web/product-http-host";

import type { HomeHubRuntime } from "./process-entry.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import { ProductSetupController } from "./product-setup-controller.js";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEFAULT_PRODUCT_SETUP_PORT = 8787;
export const PRODUCT_PAIRING_TTL_MS = 10 * 60 * 1_000;

export interface ProductSetupAnnouncement {
  readonly origin: string;
  readonly pairingCode: string;
  readonly expiresAt: Date;
}

export interface ProductSetupRuntimeOptions {
  readonly dataDirectory: string;
  readonly port?: number;
  readonly now?: () => Date;
  readonly pairingCode?: string;
  readonly createSessionToken?: () => string;
  readonly announce?: (announcement: ProductSetupAnnouncement) => void;
}

/** One Cordis root for the pre-operational product setup surface. */
export class ProductSetupRuntime implements HomeHubRuntime {
  readonly context = new Context();
  private statusValue: "created" | "starting" | "running" | "stopping" | "stopped" = "created";
  private stopTask: Promise<void> | undefined;
  private ownerLock: SetupOwnerLock | undefined;
  private productHost: ProductHttpHost | undefined;

  constructor(private readonly options: ProductSetupRuntimeOptions) {}

  get status(): "created" | "starting" | "running" | "stopping" | "stopped" {
    return this.statusValue;
  }

  async start(): Promise<void> {
    if (this.statusValue !== "created") {
      throw new Error(`Product setup runtime cannot start from ${this.statusValue} state`);
    }
    this.statusValue = "starting";
    const now = this.options.now ?? (() => new Date());
    const pairingCode = this.options.pairingCode ?? createPairingCode();
    const expiresAt = new Date(now().getTime() + PRODUCT_PAIRING_TTL_MS);
    const setupDrafts = new ProductSetupController(new ProductSetupDraftStore(this.options.dataDirectory, now));
    try {
      this.ownerLock = await acquireSetupOwnerLock(this.options.dataDirectory);
      this.productHost = new ProductHttpHost({ port: this.options.port ?? DEFAULT_PRODUCT_SETUP_PORT });
      await this.productHost.listen();
      await this.context.plugin(ProductSetupHttpService, {
        host: this.productHost,
        pairingCode,
        pairingExpiresAt: expiresAt,
        now,
        createSessionToken: this.options.createSessionToken ?? (() => randomBytes(32).toString("base64url")),
        setupDrafts,
      });
      this.context.productSetupHttp.attach();
      (this.options.announce ?? announceProductSetup)({
        origin: this.context.productSetupHttp.origin,
        pairingCode,
        expiresAt,
      });
      this.statusValue = "running";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped") return;
    if (this.stopTask !== undefined) return this.stopTask;
    this.statusValue = "stopping";
    this.stopTask = this.disposeRuntime();
    return this.stopTask;
  }

  private async disposeRuntime(): Promise<void> {
    let failure: unknown;
    try {
      await this.context.fiber.dispose();
    } catch (error) {
      failure = error;
    }
    try {
      await this.productHost?.dispose();
    } catch (error) {
      failure ??= error;
    } finally {
      this.productHost = undefined;
    }
    try {
      if (this.ownerLock !== undefined) await releaseSetupOwnerLock(this.ownerLock);
    } catch (error) {
      failure ??= error;
    } finally {
      this.ownerLock = undefined;
      this.statusValue = "stopped";
    }
    if (failure !== undefined) throw failure;
  }
}

interface SetupOwnerLock {
  readonly file: FileHandle;
  readonly path: string;
  readonly owner: string;
}

async function acquireSetupOwnerLock(directory: string): Promise<SetupOwnerLock> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "setup-runtime.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(owner, "utf8");
        await file.sync();
        return { file, path, owner };
      } catch (error) {
        await file.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    let existing = "";
    try { existing = await readFile(path, "utf8"); } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    const pid = Number(existing.split(":", 1)[0]);
    if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) {
      throw new Error("Product setup is already running for this home");
    }
    const abandonedPath = `${path}.${randomUUID()}.abandoned`;
    try { await rename(path, abandonedPath); } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    await unlink(abandonedPath);
  }
  throw new Error("Product setup is already running for this home");
}

async function releaseSetupOwnerLock(lock: SetupOwnerLock): Promise<void> {
  await lock.file.close();
  let current: string;
  try { current = await readFile(lock.path, "utf8"); } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (current === lock.owner) await unlink(lock.path);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}

export async function startProductSetupRuntime(options: ProductSetupRuntimeOptions): Promise<ProductSetupRuntime> {
  const runtime = new ProductSetupRuntime(options);
  await runtime.start();
  return runtime;
}

export function createPairingCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function announceProductSetup(announcement: ProductSetupAnnouncement): void {
  console.info(`打开 ${announcement.origin}/setup`);
  console.info(`配对码：${announcement.pairingCode}（10 分钟内有效）`);
}
