import {
  createLaunchEnvironmentSnapshot,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment";
import {
  parseModelReference,
} from "@hob-agent/agent-layer/model-reference";
import {
  providerSetup,
  type SupportedModelProvider,
} from "@hob-agent/agent-layer/model-providers";
import {
  MacOSKeychainSecretVault,
  parseSecretRef,
  type SecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import { isAbsolute, join } from "node:path";
import {
  createInboxBasicAuthenticator,
  type InboxAuthenticator,
} from "@hob-agent/inbox-web/http";

import type { BridgeAwareCredentialSource } from "./bridge-credentials.js";
import { createBuiltinBridgeCatalog } from "./bridge-bundle.js";
import type { BridgeCatalog } from "./bridge-catalog.js";
import type { BridgeConfigEntry } from "./bridge-registry.js";
import type { SelectedModelCredential } from "./model-credential-profile.js";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_CONFIG_KEY_PATTERN = /token|secret|password|passphrase|(?:api|access|private|signing|encryption).?key|credential/i;
const REQUIRED_HOME_ENV = ["HOB_DATA_DIR", "HOB_BRIDGES", "HOB_MODEL"] as const;

export type LaunchEnvironment = Readonly<Record<string, string | undefined>>;

export interface HomeHubBridgeLaunchEntry {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Alias to explicit environment variable name; values never enter config. */
  readonly credentialRefs: Readonly<Record<string, string>>;
}

export interface HomeHubLaunchConfig {
  readonly dataDirectory: string;
  readonly journalDirectory: string;
  readonly registryPath: string;
  readonly worldModelPath: string;
  readonly proposalPath: string;
  readonly artifactPath: string;
  readonly authorityCandidatePath: string;
  readonly observationAuditPath: string;
  readonly advicePath: string;
  readonly sessionPath: string;
  readonly householdDirectory?: string;
  readonly bridges: readonly BridgeConfigEntry<unknown>[];
  readonly bridgeCredentialSource: BridgeAwareCredentialSource;
  readonly catalog: BridgeCatalog;
  readonly agent: {
    readonly provider: SupportedModelProvider;
    readonly model: string;
    readonly baseURL?: string;
    readonly profile?: SelectedModelCredential["profile"];
    readonly vault?: SelectedModelCredential["vault"];
  };
  readonly inboxHttp?: {
    readonly port: number;
    readonly authenticate: InboxAuthenticator;
  };
  readonly observation?: {
    readonly intervalMinutes: number;
    readonly runOnStart: boolean;
  };
  /** DSH sees only the selected provider's standard credential alias. */
  readonly launchEnvironment: LaunchEnvironmentSnapshot;
}

export interface HomeWorldLaunchConfig {
  readonly dataDirectory: string;
  readonly journalDirectory: string;
  readonly registryPath: string;
  readonly worldModelPath: string;
  readonly bridges: readonly BridgeConfigEntry<unknown>[];
  readonly bridgeCredentialSource: BridgeAwareCredentialSource;
  readonly catalog: BridgeCatalog;
}

export interface HomeInboxLaunchConfig {
  readonly proposalPath: string;
  readonly artifactPath: string;
  readonly observationAuditPath: string;
  readonly advicePath: string;
  readonly inboxHttp: NonNullable<HomeHubLaunchConfig["inboxHttp"]>;
}

/** Reads only the persisted local Inbox slice; no bridge or model is loaded. */
export function readHomeInboxLaunchConfig(environment: LaunchEnvironment): HomeInboxLaunchConfig {
  const dataDirectory = requiredDataDirectory(environment);
  const inboxHttp = parseInboxHttp(environment.HOB_INBOX_AUTH_TOKEN, environment.HOB_INBOX_PORT);
  if (inboxHttp === undefined) {
    throw new Error("HOB_INBOX_AUTH_TOKEN is required for the standalone Inbox");
  }
  return {
    proposalPath: join(dataDirectory, "proposals.sqlite"),
    artifactPath: join(dataDirectory, "artifacts.sqlite"),
    observationAuditPath: join(dataDirectory, "observation-audit.sqlite"),
    advicePath: join(dataDirectory, "home-advice.sqlite"),
    inboxHttp,
  };
}

/** Reads only the neutral HomeWorld launch slice; no model credential is required. */
export function readHomeWorldLaunchConfig(
  environment: LaunchEnvironment,
  bridgeCredentialVault: SecretVault = new MacOSKeychainSecretVault(),
): HomeWorldLaunchConfig {
  const dataDirectory = requiredDataDirectory(environment);
  const bridgeEntries = parseBridgeEntries(requiredValue(environment, "HOB_BRIDGES"));
  const refsByBridge = new Map(bridgeEntries.map((entry) => [entry.bridgeId, entry.credentialRefs]));
  return {
    dataDirectory,
    journalDirectory: dataDirectory,
    registryPath: join(dataDirectory, "bridge-registry.sqlite"),
    worldModelPath: join(dataDirectory, "world-model.sqlite"),
    bridges: bridgeEntries.map(({ bridgeId, adapterType, config }) => ({ bridgeId, adapterType, config })),
    bridgeCredentialSource: createBridgeCredentialSource(environment, refsByBridge, bridgeCredentialVault),
    catalog: createBuiltinBridgeCatalog(),
  };
}

/**
 * Reads the neutral executable launch contract. HOB_BRIDGES contains only
 * bridge identity, adapter type, non-secret config, and env-name references;
 * the referenced values are resolved later through the bridge-scoped provider.
 */
export function readHomeHubLaunchConfig(
  environment: LaunchEnvironment,
  selectedCredential?: SelectedModelCredential,
  bridgeCredentialVault: SecretVault = new MacOSKeychainSecretVault(),
): HomeHubLaunchConfig {
  const world = readHomeWorldLaunchConfig(environment, bridgeCredentialVault);
  const modelReference = requiredValue(environment, "HOB_MODEL");

  let model: ReturnType<typeof parseModelReference>;
  try {
    model = parseModelReference(modelReference);
  } catch {
    throw new Error("Invalid HOB_MODEL; expected a supported provider/model reference");
  }

  if (selectedCredential !== undefined && selectedCredential.profile.provider !== model.provider) {
    throw new Error("Selected credential profile does not match HOB_MODEL provider");
  }
  const baseURLValue = environment.HOB_MODEL_BASE_URL;
  let provider: ReturnType<typeof providerSetup>;
  try {
    if (model.provider === "custom") {
      if (baseURLValue === undefined || baseURLValue.trim() === "") {
        throw new Error("missing");
      }
      provider = providerSetup(model.provider, { baseURL: baseURLValue });
    } else {
      if (baseURLValue !== undefined) {
        throw new Error("only-valid-for-custom");
      }
      provider = providerSetup(model.provider);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "only-valid-for-custom") {
      throw new Error("HOB_MODEL_BASE_URL is only valid for the custom provider");
    }
    throw new Error("Invalid HOB_MODEL_BASE_URL for custom model endpoint");
  }
  const credentialEnv = provider.credentialEnv;
  const launchEnvironment = selectedCredential === undefined
    ? createLaunchEnvironmentSnapshot([{
        source: "process",
        values: { [credentialEnv]: requiredValue(environment, credentialEnv).trim() },
      }])
    : createLaunchEnvironmentSnapshot([]);
  const inboxHttp = parseInboxHttp(environment.HOB_INBOX_AUTH_TOKEN, environment.HOB_INBOX_PORT);
  const householdDirectory = parseHouseholdDirectory(environment.HOB_HOME_DIR);
  const observation = parseObservationSchedule(
    environment.HOB_OBSERVATION_INTERVAL_MINUTES,
    environment.HOB_OBSERVE_ON_START,
  );
  return {
    ...world,
    proposalPath: join(world.dataDirectory, "proposals.sqlite"),
    artifactPath: join(world.dataDirectory, "artifacts.sqlite"),
    authorityCandidatePath: join(world.dataDirectory, "authority-candidates.sqlite"),
    observationAuditPath: join(world.dataDirectory, "observation-audit.sqlite"),
    advicePath: join(world.dataDirectory, "home-advice.sqlite"),
    sessionPath: join(world.dataDirectory, "dsh-sessions.sqlite"),
    ...(householdDirectory === undefined ? {} : { householdDirectory }),
    agent: {
      provider: model.provider,
      model: model.modelId,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      ...(selectedCredential === undefined ? {} : selectedCredential),
    },
    ...(inboxHttp === undefined ? {} : { inboxHttp }),
    ...(observation === undefined ? {} : { observation }),
    launchEnvironment,
  };
}

function parseObservationSchedule(
  intervalValue: string | undefined,
  runOnStartValue: string | undefined,
): HomeHubLaunchConfig["observation"] {
  if (intervalValue === undefined && runOnStartValue === undefined) return undefined;
  if (intervalValue === undefined || !/^\d+$/.test(intervalValue.trim())) {
    throw new Error("Invalid HOB_OBSERVATION_INTERVAL_MINUTES; expected 60 to 10080");
  }
  const intervalMinutes = Number(intervalValue.trim());
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 10_080) {
    throw new Error("Invalid HOB_OBSERVATION_INTERVAL_MINUTES; expected 60 to 10080");
  }
  const runOnStart = runOnStartValue === undefined ? false : runOnStartValue.trim();
  if (runOnStart !== false && runOnStart !== "true" && runOnStart !== "false") {
    throw new Error("Invalid HOB_OBSERVE_ON_START; expected true or false");
  }
  return { intervalMinutes, runOnStart: runOnStart === "true" };
}

function parseHouseholdDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const directory = value.trim();
  if (!isAbsolute(directory)
    || directory === ":memory:"
    || /(?:^|[\\/])\.env(?:$|[\\/])/i.test(directory)) {
    throw new Error("Invalid HOB_HOME_DIR; expected an absolute household directory");
  }
  return directory;
}

function parseInboxHttp(
  token: string | undefined,
  portValue: string | undefined,
): HomeHubLaunchConfig["inboxHttp"] {
  if (token === undefined && portValue === undefined) return undefined;
  if (token === undefined) throw new Error("HOB_INBOX_AUTH_TOKEN is required when Inbox HTTP is configured");
  let authenticate: InboxAuthenticator;
  try {
    authenticate = createInboxBasicAuthenticator(token);
  } catch {
    throw new Error("Invalid HOB_INBOX_AUTH_TOKEN; expected 32 to 512 characters");
  }
  const port = portValue === undefined ? 8_787 : parseProductionPort(portValue);
  return { port, authenticate };
}

function parseProductionPort(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error("Invalid HOB_INBOX_PORT; expected an integer from 1 to 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Invalid HOB_INBOX_PORT; expected an integer from 1 to 65535");
  }
  return port;
}

function requiredDataDirectory(environment: LaunchEnvironment): string {
  const value = requiredValue(environment, "HOB_DATA_DIR").trim();
  if (!isAbsolute(value)
    || value === ":memory:"
    || /(?:^|[\\/])\.env(?:$|[\\/])/i.test(value)) {
    throw new Error("Invalid HOB_DATA_DIR; expected an absolute private data directory");
  }
  return value;
}

function parseBridgeEntries(raw: string): readonly HomeHubBridgeLaunchEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid HOB_BRIDGES; expected a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("Invalid HOB_BRIDGES; expected a JSON array");

  const seen = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Invalid HOB_BRIDGES entry at index ${index}`);
    const bridgeId = nonEmptyString(candidate.bridgeId);
    const adapterType = nonEmptyString(candidate.adapterType);
    if (bridgeId === undefined || adapterType === undefined) {
      throw new Error(`Invalid HOB_BRIDGES entry at index ${index}`);
    }
    if (seen.has(bridgeId)) throw new Error(`Duplicate HOB_BRIDGES bridgeId "${bridgeId}"`);
    seen.add(bridgeId);
    if (!isRecord(candidate.config) || Array.isArray(candidate.config)) {
      throw new Error(`Invalid HOB_BRIDGES config for "${bridgeId}"`);
    }
    rejectSecretConfig(candidate.config, bridgeId);
    const credentialRefs = parseCredentialRefs(candidate.credentialRefs, bridgeId);
    return {
      bridgeId,
      adapterType,
      config: candidate.config,
      credentialRefs,
    };
  });
}

function parseCredentialRefs(value: unknown, bridgeId: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Invalid HOB_BRIDGES credentialRefs for "${bridgeId}"`);
  }
  const refs: Record<string, string> = {};
  for (const [alias, locatorValue] of Object.entries(value)) {
    const locator = nonEmptyString(locatorValue);
    if (alias.trim() === "" || locator === undefined) {
      throw new Error(`Invalid HOB_BRIDGES credentialRef for "${bridgeId}"`);
    }
    if (ENV_NAME_PATTERN.test(locator)) {
      refs[alias] = `env:${locator}`;
      continue;
    }
    let ref;
    try {
      ref = parseSecretRef(locator);
    } catch {
      throw new Error(`Invalid HOB_BRIDGES credentialRef for "${bridgeId}"`);
    }
    if (ref.source === "env") {
      refs[alias] = locator;
      continue;
    }
    if (ref.id !== `hob-agent/bridge:${bridgeId}:${alias}`) {
      throw new Error(`Invalid HOB_BRIDGES credentialRef for "${bridgeId}"`);
    }
    refs[alias] = locator;
  }
  return Object.freeze(refs);
}

function rejectSecretConfig(config: Record<string, unknown>, bridgeId: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_CONFIG_KEY_PATTERN.test(key)) {
      throw new Error(`Secret-like field "${key}" is not allowed in HOB_BRIDGES config for "${bridgeId}"`);
    }
    if (isRecord(value) && !Array.isArray(value)) rejectSecretConfig(value, bridgeId);
    if (Array.isArray(value)) {
      for (const item of value) if (isRecord(item) && !Array.isArray(item)) rejectSecretConfig(item, bridgeId);
    }
  }
}

function createBridgeCredentialSource(
  environment: LaunchEnvironment,
  refsByBridge: ReadonlyMap<string, Readonly<Record<string, string>>>,
  vault: SecretVault,
): BridgeAwareCredentialSource {
  return Object.freeze({
    async resolveForBridge(bridgeId: string, alias: string) {
      const refs = refsByBridge.get(bridgeId);
      const locator = refs !== undefined && Object.prototype.hasOwnProperty.call(refs, alias)
        ? refs[alias]
        : undefined;
      if (locator === undefined) return undefined;
      const ref = parseSecretRef(locator);
      const value = ref.source === "env"
        ? environment[ref.id]
        : await vault.read(locator);
      return typeof value === "string" && value.trim() !== ""
        ? { kind: "secret_text" as const, value }
        : undefined;
    },
    async describeForBridge(bridgeId: string, alias: string) {
      const refs = refsByBridge.get(bridgeId);
      const locator = refs !== undefined && Object.prototype.hasOwnProperty.call(refs, alias)
        ? refs[alias]
        : undefined;
      if (locator === undefined) return { configured: false };
      const ref = parseSecretRef(locator);
      if (ref.source === "keychain") return { configured: true };
      const value = environment[ref.id];
      return { configured: typeof value === "string" && value.trim() !== "" };
    },
  });
}

function requiredValue(environment: LaunchEnvironment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required launch environment variable: ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export { REQUIRED_HOME_ENV };
