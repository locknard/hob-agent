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
import type { InboxReviewActor } from "@hob-agent/inbox-web/service";

import type { BridgeAwareCredentialSource } from "./bridge/bridge-credentials.js";
import { createBuiltinBridgeCatalog } from "./bridge/bridge-bundle.js";
import type { BridgeCatalog } from "./bridge/bridge-catalog.js";
import type { BridgeConfigEntry } from "./bridge/bridge-registry.js";
import type { SelectedModelCredential } from "./model-credential-profile.js";
import {
  parseMusicAssistantCredentialRef,
} from "./cli/music-assistant-credential-setup.js";
import { toMusicAssistantWebSocketUrl } from "./media/music-assistant-websocket-client.js";
import { parseHomeSafetyBindings, type HomeSafetyBinding } from "./home/home-safety-service.js";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_CONFIG_KEY_PATTERN = /token|secret|password|passphrase|(?:api|access|private|signing|encryption).?key|credential/i;
const REQUIRED_HOME_ENV = ["HOB_DATA_DIR", "HOB_BRIDGES", "HOB_MODEL"] as const;
const INBOX_REVIEW_ROLES = ["admin", "adult_member", "member", "child", "guest"] as const;
const INBOX_DEVICE_KINDS = ["private", "shared"] as const;

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
  readonly oneShotActionPath: string;
  readonly batchActionPath: string;
  readonly artifactPath: string;
  readonly authorityCandidatePath: string;
  readonly observationAuditPath: string;
  readonly advicePath: string;
  readonly safetyPath: string;
  readonly sessionPath: string;
  readonly onboardingPath: string;
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
    readonly principal: InboxReviewActor;
  };
  readonly observation?: {
    readonly intervalMinutes: number;
    readonly runOnStart: boolean;
  };
  readonly safetyBindings: readonly HomeSafetyBinding[];
  /** Explicit read-only Music Assistant transport; omitted unless both launch settings exist. */
  readonly musicAssistant?: {
    readonly baseUrl: string;
    readonly resolveToken: (signal: AbortSignal) => Promise<string | undefined>;
    /** Hub-private neutral capability to Music Assistant player binding. */
    readonly playerIdForCapability?: (capabilityId: string) => string | undefined;
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

export interface ProductBootstrapLaunchConfig {
  readonly dataDirectory: string;
}

/** Reads the private process root needed before a household generation exists. */
export function readProductBootstrapLaunchConfig(
  environment: LaunchEnvironment,
): ProductBootstrapLaunchConfig {
  return { dataDirectory: requiredDataDirectory(environment) };
}

/** Reads only the neutral HomeWorld launch slice; no model credential is required. */
export function readHomeWorldLaunchConfig(
  environment: LaunchEnvironment,
  bridgeCredentialVault: SecretVault = new MacOSKeychainSecretVault(),
): HomeWorldLaunchConfig {
  const { dataDirectory } = readProductBootstrapLaunchConfig(environment);
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
  const musicAssistant = parseMusicAssistantConfiguration(environment, bridgeCredentialVault);
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
  const inboxHttp = parseInboxHttp(
    environment.HOB_INBOX_AUTH_TOKEN,
    environment.HOB_INBOX_PORT,
    environment.HOB_INBOX_PRINCIPAL_ID,
    environment.HOB_INBOX_PRINCIPAL_ROLE,
    environment.HOB_INBOX_DEVICE_KIND,
    environment.HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID,
  );
  const householdDirectory = parseHouseholdDirectory(environment.HOB_HOME_DIR);
  const observation = parseObservationSchedule(
    environment.HOB_OBSERVATION_INTERVAL_MINUTES,
    environment.HOB_OBSERVE_ON_START,
  );
  const safetyBindings = parseSafetyBindingsConfiguration(environment.HOB_SAFETY_BINDINGS);
  return {
    ...world,
    proposalPath: join(world.dataDirectory, "proposals.sqlite"),
    oneShotActionPath: join(world.dataDirectory, "one-shot-actions.sqlite"),
    batchActionPath: join(world.dataDirectory, "batch-actions.sqlite"),
    artifactPath: join(world.dataDirectory, "artifacts.sqlite"),
    authorityCandidatePath: join(world.dataDirectory, "authority-candidates.sqlite"),
    observationAuditPath: join(world.dataDirectory, "observation-audit.sqlite"),
    advicePath: join(world.dataDirectory, "home-advice.sqlite"),
    safetyPath: join(world.dataDirectory, "home-safety.sqlite"),
    sessionPath: join(world.dataDirectory, "dsh-sessions.sqlite"),
    onboardingPath: join(world.dataDirectory, "onboarding.sqlite"),
    ...(householdDirectory === undefined ? {} : { householdDirectory }),
    agent: {
      provider: model.provider,
      model: model.modelId,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      ...(selectedCredential === undefined ? {} : selectedCredential),
    },
    ...(inboxHttp === undefined ? {} : { inboxHttp }),
    ...(observation === undefined ? {} : { observation }),
    safetyBindings,
    ...(musicAssistant === undefined ? {} : { musicAssistant }),
    launchEnvironment,
  };
}

function parseSafetyBindingsConfiguration(value: string | undefined): readonly HomeSafetyBinding[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  try {
    return parseHomeSafetyBindings(JSON.parse(value));
  } catch {
    throw new Error("Invalid HOB_SAFETY_BINDINGS");
  }
}

function parseMusicAssistantConfiguration(
  environment: LaunchEnvironment,
  vault: SecretVault,
): HomeHubLaunchConfig["musicAssistant"] {
  const baseUrlValue = environment.HOB_MUSIC_ASSISTANT_BASE_URL;
  const credentialRefValue = environment.HOB_MUSIC_ASSISTANT_CREDENTIAL_REF;
  const playerBindingsValue = environment.HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS;
  const hasBaseUrl = typeof baseUrlValue === "string" && baseUrlValue.trim() !== "";
  const hasCredentialRef = typeof credentialRefValue === "string" && credentialRefValue.trim() !== "";
  const hasPlayerBindings = typeof playerBindingsValue === "string" && playerBindingsValue.trim() !== "";
  if (!hasBaseUrl && !hasCredentialRef && !hasPlayerBindings) return undefined;
  if (!hasBaseUrl) {
    throw new Error("HOB_MUSIC_ASSISTANT_BASE_URL is required with HOB_MUSIC_ASSISTANT_CREDENTIAL_REF");
  }
  if (!hasCredentialRef) {
    throw new Error("HOB_MUSIC_ASSISTANT_CREDENTIAL_REF is required with HOB_MUSIC_ASSISTANT_BASE_URL");
  }

  const baseUrl = baseUrlValue.trim();
  try {
    toMusicAssistantWebSocketUrl(baseUrl);
  } catch {
    throw new Error("Invalid HOB_MUSIC_ASSISTANT_BASE_URL");
  }
  let credentialRef: ReturnType<typeof parseMusicAssistantCredentialRef>;
  try {
    credentialRef = parseMusicAssistantCredentialRef(credentialRefValue.trim());
  } catch {
    throw new Error("Invalid HOB_MUSIC_ASSISTANT_CREDENTIAL_REF");
  }
  const playerIdForCapability = hasPlayerBindings
    ? parseMusicAssistantPlayerBindings(playerBindingsValue)
    : undefined;
  return {
    baseUrl,
    resolveToken: async (signal) => {
      if (signal.aborted) return undefined;
      const value = credentialRef.startsWith("env:")
        ? environment[credentialRef.slice("env:".length)]
        : await vault.read(credentialRef);
      if (signal.aborted) return undefined;
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    },
    ...(playerIdForCapability === undefined ? {} : { playerIdForCapability }),
  };
}

function parseMusicAssistantPlayerBindings(
  value: string | undefined,
): (capabilityId: string) => string | undefined {
  let input: unknown;
  try {
    input = JSON.parse(value ?? "");
  } catch {
    throw new Error("Invalid HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS");
  }
  const bindings = Object.create(null) as Record<string, string>;
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > 128) {
    throw new Error("Invalid HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS");
  }
  for (const [capabilityId, playerId] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(capabilityId)
      || typeof playerId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(playerId)) {
      throw new Error("Invalid HOB_MUSIC_ASSISTANT_PLAYER_BINDINGS");
    }
    bindings[capabilityId] = playerId;
  }
  const frozen = Object.freeze(bindings);
  return (capabilityId) => frozen[capabilityId];
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
  principalIdValue: string | undefined,
  roleValue: string | undefined,
  deviceKindValue: string | undefined,
  boundPrincipalIdValue: string | undefined,
): HomeHubLaunchConfig["inboxHttp"] {
  const values = [token, portValue, principalIdValue, roleValue, deviceKindValue, boundPrincipalIdValue];
  if (values.every((value) => value === undefined)) return undefined;
  if (token === undefined) throw new Error("HOB_INBOX_AUTH_TOKEN is required when Inbox HTTP is configured");
  let authenticate: InboxAuthenticator;
  try {
    authenticate = createInboxBasicAuthenticator(token);
  } catch {
    throw new Error("Invalid HOB_INBOX_AUTH_TOKEN; expected 32 to 512 characters");
  }
  const port = portValue === undefined ? 8_787 : parseProductionPort(portValue);
  const principalId = requiredInboxPrincipalId(principalIdValue);
  const role = requiredInboxRole(roleValue);
  const deviceKind = requiredInboxDeviceKind(deviceKindValue);
  const boundPrincipalId = boundPrincipalIdValue === undefined
    ? undefined
    : requiredInboxText(boundPrincipalIdValue, "HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID");
  if (deviceKind === "private" && boundPrincipalId === undefined) {
    throw new Error("HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID is required for a private Inbox device");
  }
  if (deviceKind === "private" && boundPrincipalId !== principalId) {
    throw new Error("HOB_INBOX_DEVICE_BOUND_PRINCIPAL_ID must match HOB_INBOX_PRINCIPAL_ID");
  }
  if (deviceKind === "shared" && boundPrincipalId !== undefined) {
    throw new Error("A shared Inbox device uses no private principal binding");
  }
  return {
    port,
    authenticate,
    principal: {
      principalId,
      role,
      present: true,
      device: {
        kind: deviceKind,
        ...(boundPrincipalId === undefined ? {} : { boundPrincipalId }),
      },
    },
  };
}

function requiredInboxPrincipalId(value: string | undefined): string {
  return requiredInboxText(value, "HOB_INBOX_PRINCIPAL_ID");
}

function requiredInboxRole(value: string | undefined): InboxReviewActor["role"] {
  const role = requiredInboxText(value, "HOB_INBOX_PRINCIPAL_ROLE");
  if (!(INBOX_REVIEW_ROLES as readonly string[]).includes(role)) {
    throw new Error("Invalid HOB_INBOX_PRINCIPAL_ROLE; expected admin, adult_member, member, child, or guest");
  }
  return role as InboxReviewActor["role"];
}

function requiredInboxDeviceKind(value: string | undefined): InboxReviewActor["device"]["kind"] {
  const kind = requiredInboxText(value, "HOB_INBOX_DEVICE_KIND");
  if (!(INBOX_DEVICE_KINDS as readonly string[]).includes(kind)) {
    throw new Error("Invalid HOB_INBOX_DEVICE_KIND; expected private or shared");
  }
  return kind as InboxReviewActor["device"]["kind"];
}

function requiredInboxText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new Error(`${name} is required when Inbox HTTP is configured`);
  }
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${name}`);
  }
  return normalized;
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
