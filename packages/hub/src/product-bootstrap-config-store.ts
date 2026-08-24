import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { AuthProfile } from "@hob-agent/agent-layer/model-credentials";
import { validateCustomModelBaseURL } from "@hob-agent/agent-layer/model-providers";
import { normalizePrivateVoiceEndpoint } from "./voice/private-voice-endpoint.js";

const CONFIG_VERSION = "hob.product-config/v3" as const;
const LEGACY_CONFIG_VERSION = "hob.product-config/v2" as const;
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

export interface ProductBootstrapVoiceAsrConfig {
  readonly transport: "wyoming" | "openai_http";
  readonly endpoint: string;
  readonly credentialRef?: string;
  readonly model?: string;
}

export interface ProductBootstrapVoiceTtsConfig extends ProductBootstrapVoiceAsrConfig {
  readonly locale: string;
  readonly voice?: string;
}

/** Complete, probe-verified runtime configuration for the optional private voice path. */
export interface ProductVoiceRuntimeConfig {
  readonly asr: ProductBootstrapVoiceAsrConfig;
  readonly tts: ProductBootstrapVoiceTtsConfig;
}

export interface ProductBootstrapConfigDraft {
  readonly householdName: string;
  readonly agentName: string;
  readonly modelReference: string;
  readonly modelBaseURL?: string;
  readonly modelProfile: AuthProfile;
  readonly bridges: readonly ProductBootstrapBridgeConfig[];
  readonly voice?: ProductVoiceRuntimeConfig;
}

export interface ProductBootstrapConfiguration extends ProductBootstrapConfigDraft {
  readonly version: typeof CONFIG_VERSION;
  readonly generation: number;
  readonly activatedAt: string;
}

/** The only model fields an operational settings change may replace. */
export interface ProductBootstrapModelConfig {
  readonly modelReference: string;
  readonly modelBaseURL?: string;
  readonly modelProfile: AuthProfile;
}

export class ProductBootstrapConfigurationConflictError extends Error {
  constructor() {
    super("Product configuration generation conflict");
    this.name = "ProductBootstrapConfigurationConflictError";
  }
}

/** Durable non-secret generation owned by the single production composition root. */
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
    return this.exclusive(async () => {
      const current = await this.load();
      if ((current?.generation ?? 0) !== expectedGeneration) throw new ProductBootstrapConfigurationConflictError();
      return this.writeConfiguration(Object.freeze({
        version: CONFIG_VERSION,
        generation: expectedGeneration + 1,
        activatedAt: this.now().toISOString(),
        ...validated,
      }));
    });
  }

  /** Replaces only the optional voice capability on an already activated product generation. */
  async commitVoice(expectedGeneration: number, voice: ProductVoiceRuntimeConfig | undefined): Promise<ProductBootstrapConfiguration> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TypeError("Expected generation is invalid");
    const validatedVoice = voice === undefined ? undefined : validateVoiceRuntimeConfig(voice);
    return this.exclusive(async () => {
      const current = await this.load();
      if (current === undefined || current.generation !== expectedGeneration) throw new ProductBootstrapConfigurationConflictError();
      const { version: _version, generation: _generation, activatedAt, voice: _voice, ...draft } = current;
      return this.writeConfiguration(Object.freeze({
        version: CONFIG_VERSION,
        generation: expectedGeneration + 1,
        activatedAt,
        ...draft,
        ...(validatedVoice === undefined ? {} : { voice: validatedVoice }),
      }));
    });
  }

  /** Replaces only the active model after its operational credential has been verified. */
  async commitModel(expectedGeneration: number, model: ProductBootstrapModelConfig): Promise<ProductBootstrapConfiguration> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TypeError("Expected generation is invalid");
    const validated = validateModelConfig(model, "operational");
    return this.exclusive(async () => {
      const current = await this.load();
      if (current === undefined || current.generation !== expectedGeneration) throw new ProductBootstrapConfigurationConflictError();
      const { version: _version, generation: _generation, activatedAt, modelReference: _reference, modelBaseURL: _baseURL, modelProfile: _profile, ...preserved } = current;
      return this.writeConfiguration(Object.freeze({
        version: CONFIG_VERSION,
        generation: expectedGeneration + 1,
        activatedAt,
        ...preserved,
        ...validated,
      }));
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const lock = await acquireConfigurationLock(this.lockPath);
    try {
      return await operation();
    } finally {
      await releaseConfigurationLock(this.lockPath, lock);
    }
  }

  private async writeConfiguration(configuration: ProductBootstrapConfiguration): Promise<ProductBootstrapConfiguration> {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
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
  if (!isRecord(value) || (value.version !== CONFIG_VERSION && value.version !== LEGACY_CONFIG_VERSION)
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) {
    throw new Error("Product configuration header is invalid");
  }
  if (typeof value.activatedAt !== "string" || !Number.isFinite(Date.parse(value.activatedAt))) {
    throw new Error("Product configuration activation time is invalid");
  }
  const draft = validateDraft(value);
  if (value.version === LEGACY_CONFIG_VERSION && draft.voice !== undefined) {
    throw new Error("Product configuration header is invalid");
  }
  return Object.freeze({
    version: CONFIG_VERSION,
    generation: Number(value.generation),
    activatedAt: value.activatedAt,
    ...draft,
  });
}

function validateDraft(value: ProductBootstrapConfigDraft | Record<string, unknown>): ProductBootstrapConfigDraft {
  if (!isRecord(value)) throw new TypeError("Product configuration draft is invalid");
  const { modelReference, modelBaseURL, modelProfile } = validateModelConfig(value);
  const householdName = boundedName(value.householdName, "Household name");
  const agentName = boundedName(value.agentName, "Agent name");
  const voice = value.voice === undefined ? undefined : validateVoiceRuntimeConfig(value.voice);
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
      if (!ID.test(alias) || (!new RegExp(`^(?:keychain|vault):hob-agent/bridge:${bridgeId}:${alias}$`, "u").test(reference) && !/^env:[A-Z][A-Z0-9_]*$/u.test(reference))) {
        throw new TypeError("Bridge credential reference is invalid");
      }
      credentialRefs[alias] = reference;
    }
    return Object.freeze({ bridgeId, adapterType, config, credentialRefs: Object.freeze(credentialRefs) });
  });
  return Object.freeze({
    householdName,
    agentName,
    modelReference,
    ...(modelBaseURL === undefined ? {} : { modelBaseURL }),
    modelProfile,
    bridges: Object.freeze(bridges),
    ...(voice === undefined ? {} : { voice }),
  });
}

function validateModelConfig(value: Pick<ProductBootstrapModelConfig, "modelReference" | "modelBaseURL" | "modelProfile"> | Record<string, unknown>, profileScope?: "operational"): ProductBootstrapModelConfig {
  const modelReference = boundedString(value.modelReference, 300, "Model reference");
  if (/\s/u.test(modelReference) || !modelReference.includes("/")) throw new TypeError("Model reference is invalid");
  const provider = modelReference.slice(0, modelReference.indexOf("/"));
  if (!/^(?:gpt|claude|deepseek|kimi|glm|custom)$/u.test(provider)) throw new TypeError("Model reference is invalid");
  const modelProfile = validateModelProfile(value.modelProfile, provider, profileScope);
  const modelBaseURL = value.modelBaseURL === undefined ? undefined : customModelBaseURL(provider, value.modelBaseURL);
  return Object.freeze({
    modelReference,
    ...(modelBaseURL === undefined ? {} : { modelBaseURL }),
    modelProfile,
  });
}

function validateVoiceRuntimeConfig(value: unknown): ProductVoiceRuntimeConfig {
  if (!isRecord(value)) throw new TypeError("Voice configuration is invalid");
  assertExactKeys(value, ["asr", "tts"], "Voice configuration is invalid");
  return Object.freeze({
    asr: validateVoiceAsrConfig(value.asr),
    tts: validateVoiceTtsConfig(value.tts),
  });
}

function validateVoiceAsrConfig(value: unknown): ProductBootstrapVoiceAsrConfig {
  if (!isRecord(value)) throw new TypeError("Voice configuration is invalid");
  assertExactKeys(value, ["transport", "endpoint", "credentialRef", "model"], "Voice configuration is invalid");
  const transport = voiceTransport(value.transport);
  const credentialRef = value.credentialRef === undefined ? undefined : voiceCredentialRef("asr", value.credentialRef);
  const endpoint = voiceEndpoint(transport, value.endpoint, credentialRef !== undefined);
  if (transport === "wyoming" && credentialRef !== undefined) throw new TypeError("Voice configuration is invalid");
  const model = value.model === undefined ? undefined : voiceLabel(value.model);
  return Object.freeze({ transport, endpoint, ...(credentialRef === undefined ? {} : { credentialRef }), ...(model === undefined ? {} : { model }) });
}

function validateVoiceTtsConfig(value: unknown): ProductBootstrapVoiceTtsConfig {
  if (!isRecord(value)) throw new TypeError("Voice configuration is invalid");
  assertExactKeys(value, ["transport", "endpoint", "credentialRef", "model", "locale", "voice"], "Voice configuration is invalid");
  const transport = voiceTransport(value.transport);
  const credentialRef = value.credentialRef === undefined ? undefined : voiceCredentialRef("tts", value.credentialRef);
  const endpoint = voiceEndpoint(transport, value.endpoint, credentialRef !== undefined);
  if (transport === "wyoming" && credentialRef !== undefined) throw new TypeError("Voice configuration is invalid");
  const model = value.model === undefined ? undefined : voiceLabel(value.model);
  if (transport === "wyoming" && model !== undefined) throw new TypeError("Voice configuration is invalid");
  const locale = voiceLocale(value.locale);
  const voice = value.voice === undefined ? undefined : voiceLabel(value.voice);
  return Object.freeze({ transport, endpoint, ...(credentialRef === undefined ? {} : { credentialRef }), locale, ...(voice === undefined ? {} : { voice }), ...(model === undefined ? {} : { model }) });
}

function voiceTransport(value: unknown): "wyoming" | "openai_http" {
  if (value !== "wyoming" && value !== "openai_http") throw new TypeError("Voice configuration is invalid");
  return value;
}

function voiceEndpoint(transport: "wyoming" | "openai_http", value: unknown, hasCredential: boolean): string {
  try {
    return normalizePrivateVoiceEndpoint(transport, value, { hasCredential });
  } catch {
    throw new TypeError("Voice configuration is invalid");
  }
}

function voiceCredentialRef(kind: "asr" | "tts", value: unknown): string {
  const reference = boundedString(value, 512, "Voice credential reference");
  if (!new RegExp(`^(?:keychain|vault):hob-agent/voice:${kind}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, "u").test(reference)) {
    throw new TypeError("Voice configuration is invalid");
  }
  return reference;
}

function voiceLocale(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Voice configuration is invalid");
  try {
    const [locale] = Intl.getCanonicalLocales(value.trim());
    if (locale === undefined || locale.length > 35) throw new TypeError("Voice configuration is invalid");
    return locale;
  } catch {
    throw new TypeError("Voice configuration is invalid");
  }
}

function voiceLabel(value: unknown): string {
  const label = boundedString(value, 128, "Voice label");
  if (/[\u0000-\u001f\u007f]/u.test(label)) throw new TypeError("Voice configuration is invalid");
  return label;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError(message);
}

function validateModelProfile(value: unknown, provider: string, requiredScope?: "operational"): AuthProfile {
  if (!isRecord(value) || value.provider !== provider || value.kind !== "api_key"
    || typeof value.id !== "string" || typeof value.secretRef !== "string") {
    throw new TypeError("Model profile is invalid");
  }
  const setup = /^([A-Za-z0-9_-]+):setup:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(value.id);
  const operational = /^([A-Za-z0-9_-]+):operational:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(value.id);
  const validSetup = setup !== null && setup[1] === provider
    && new RegExp(`^(?:keychain|vault):hob-agent/setup-model:${setup[2]}:[A-Za-z0-9_-]+$`, "u").test(value.secretRef);
  const validOperational = operational !== null && operational[1] === provider
    && new RegExp(`^(?:keychain|vault):hob-agent/model:${operational[2]}:[A-Za-z0-9_-]+$`, "u").test(value.secretRef);
  if ((requiredScope === "operational" ? !validOperational : !(validSetup || validOperational))) {
    throw new TypeError("Model profile is invalid");
  }
  return Object.freeze({ id: value.id, provider: value.provider, kind: "api_key", secretRef: value.secretRef });
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

function customModelBaseURL(provider: string, value: unknown): string {
  if (provider !== "custom") throw new TypeError("Model endpoint is invalid");
  try {
    return validateCustomModelBaseURL(boundedString(value, 2_048, "Model endpoint"));
  } catch {
    throw new TypeError("Model endpoint is invalid");
  }
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function boundedName(value: unknown, label: string): string {
  const name = boundedString(value, 40, label).normalize("NFKC");
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new TypeError(`${label} is invalid`);
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
