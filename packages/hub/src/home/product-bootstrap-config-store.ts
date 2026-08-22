import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_VERSION = "hob.product-config/v1" as const;
const SECRET_KEY = /token|secret|password|passphrase|(?:api|access|private|signing|encryption).?key|credential/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_FILE_BYTES = 65_536;
const LOCK_STALE_AFTER_MS = 30_000;

export interface ProductBootstrapBridgeConfig {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
}

export interface ProductBootstrapConfigDraft {
  readonly modelReference: string;
  readonly modelBaseURL?: string;
  readonly bridges: readonly ProductBootstrapBridgeConfig[];
}

export interface ProductBootstrapConfiguration extends ProductBootstrapConfigDraft {
  readonly version: typeof CONFIG_VERSION;
  readonly generation: number;
  readonly activatedAt: string;
}

/** Durable non-secret product generation used by the single production launch path. */
export class ProductBootstrapConfigStore {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(directory, "product-config.json");
    this.lockPath = join(directory, "product-config.lock");
  }

  async load(): Promise<ProductBootstrapConfiguration | undefined> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Product configuration exceeds its size limit");
    return validateConfiguration(JSON.parse(source) as unknown);
  }

  async commit(expectedGeneration: number, draft: ProductBootstrapConfigDraft): Promise<ProductBootstrapConfiguration> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TypeError("Expected generation is invalid");
    const validated = validateDraft(draft);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const lock = await acquireConfigurationLock(this.lockPath);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const current = await this.load();
      if ((current?.generation ?? 0) !== expectedGeneration) throw new Error("Product configuration generation conflict");
      const configuration: ProductBootstrapConfiguration = Object.freeze({
        version: CONFIG_VERSION,
        generation: expectedGeneration + 1,
        activatedAt: this.now().toISOString(),
        ...validated,
      });
      const source = `${JSON.stringify(configuration)}\n`;
      if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Product configuration exceeds its size limit");
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(source, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      return configuration;
    } finally {
      await unlink(temporaryPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
      await releaseConfigurationLock(this.lockPath, lock);
    }
  }
}

interface ConfigurationLock {
  readonly file: Awaited<ReturnType<typeof open>>;
  readonly owner: string;
}

async function acquireConfigurationLock(lockPath: string): Promise<ConfigurationLock> {
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      try {
        await file.writeFile(owner, "utf8");
        await file.sync();
        return { file, owner };
      } catch (error) {
        await file.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    let lockAge: number;
    try {
      lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (lockAge <= LOCK_STALE_AFTER_MS) throw new Error("Product configuration is busy");

    const abandonedPath = `${lockPath}.${randomUUID()}.abandoned`;
    try {
      await rename(lockPath, abandonedPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    await unlink(abandonedPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  }
  throw new Error("Product configuration is busy");
}

async function releaseConfigurationLock(lockPath: string, lock: ConfigurationLock): Promise<void> {
  await lock.file.close();
  let owner: string;
  try {
    owner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (owner !== lock.owner) return;
  await unlink(lockPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
}

function validateConfiguration(value: unknown): ProductBootstrapConfiguration {
  if (!isRecord(value) || value.version !== CONFIG_VERSION || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) {
    throw new Error("Product configuration header is invalid");
  }
  if (typeof value.activatedAt !== "string" || !Number.isFinite(Date.parse(value.activatedAt))) {
    throw new Error("Product configuration activation time is invalid");
  }
  return Object.freeze({
    version: CONFIG_VERSION,
    generation: Number(value.generation),
    activatedAt: value.activatedAt,
    ...validateDraft(value),
  });
}

function validateDraft(value: ProductBootstrapConfigDraft | Record<string, unknown>): ProductBootstrapConfigDraft {
  if (!isRecord(value)) throw new TypeError("Product configuration draft is invalid");
  const modelReference = boundedString(value.modelReference, 300, "Model reference");
  if (/\s/u.test(modelReference) || !modelReference.includes("/")) throw new TypeError("Model reference is invalid");
  const modelBaseURL = value.modelBaseURL === undefined ? undefined : safeHttpsURL(value.modelBaseURL);
  if (!Array.isArray(value.bridges) || value.bridges.length > 16) throw new TypeError("Bridge configuration list is invalid");
  const seen = new Set<string>();
  const bridges = value.bridges.map((bridge) => {
    if (!isRecord(bridge)) throw new TypeError("Bridge configuration is invalid");
    const bridgeId = boundedString(bridge.bridgeId, 128, "Bridge id");
    const adapterType = boundedString(bridge.adapterType, 128, "Adapter type");
    if (!ID.test(bridgeId) || !ID.test(adapterType) || seen.has(bridgeId)) throw new TypeError("Bridge identity is invalid");
    seen.add(bridgeId);
    if (!isRecord(bridge.config) || Array.isArray(bridge.config)) throw new TypeError("Bridge config is invalid");
    rejectSecretFields(bridge.config);
    const config = cloneJsonObject(bridge.config);
    if (!isRecord(bridge.credentialRefs) || Array.isArray(bridge.credentialRefs)) throw new TypeError("Bridge credential references are invalid");
    const credentialRefs: Record<string, string> = {};
    for (const [alias, rawReference] of Object.entries(bridge.credentialRefs)) {
      const reference = boundedString(rawReference, 300, "Bridge credential reference");
      if (!ID.test(alias) || (reference !== `keychain:hob-agent/bridge:${bridgeId}:${alias}` && !/^env:[A-Z][A-Z0-9_]*$/u.test(reference))) {
        throw new TypeError("Bridge credential reference is invalid");
      }
      credentialRefs[alias] = reference;
    }
    return Object.freeze({ bridgeId, adapterType, config, credentialRefs: Object.freeze(credentialRefs) });
  });
  return Object.freeze({ modelReference, ...(modelBaseURL === undefined ? {} : { modelBaseURL }), bridges: Object.freeze(bridges) });
}

function rejectSecretFields(value: Readonly<Record<string, unknown>>): void {
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`Bridge config contains secret-shaped field: ${key}`);
    if (isRecord(child)) rejectSecretFields(child);
    else if (Array.isArray(child)) for (const item of child) if (isRecord(item)) rejectSecretFields(item);
  }
}

function cloneJsonObject(value: Readonly<Record<string, unknown>>, depth = 0): Readonly<Record<string, unknown>> {
  if (depth > 12 || Object.keys(value).length > 256 || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Bridge config structure is invalid");
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128) throw new TypeError("Bridge config key is invalid");
    output[key] = cloneJsonValue(child, depth + 1);
  }
  return Object.freeze(output);
}

function cloneJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000 || depth > 12) throw new TypeError("Bridge config array is invalid");
    return Object.freeze(value.map((item) => cloneJsonValue(item, depth + 1)));
  }
  if (isRecord(value)) return cloneJsonObject(value, depth);
  throw new TypeError("Bridge config value is invalid");
}

function safeHttpsURL(value: unknown): string {
  const source = boundedString(value, 2_048, "Model endpoint");
  let url: URL;
  try { url = new URL(source); } catch { throw new TypeError("Model endpoint is invalid"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new TypeError("Model endpoint is invalid");
  return url.toString().replace(/\/$/u, "");
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
