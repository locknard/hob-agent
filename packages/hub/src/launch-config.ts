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
import { isAbsolute, join } from "node:path";
import {
  createInboxBasicAuthenticator,
  type InboxAuthenticator,
} from "@hob-agent/inbox-web/http";

import type { BridgeAwareCredentialSource } from "./bridge-credentials.js";
import { createBuiltinBridgeCatalog } from "./bridge-bundle.js";
import type { BridgeCatalog } from "./bridge-catalog.js";
import type { BridgeConfigEntry } from "./bridge-registry.js";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_CONFIG_KEY_PATTERN = /token|secret|password|private.?key|credential/i;
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
  readonly bridges: readonly BridgeConfigEntry<unknown>[];
  readonly bridgeCredentialSource: BridgeAwareCredentialSource;
  readonly catalog: BridgeCatalog;
  readonly agent: {
    readonly provider: SupportedModelProvider;
    readonly model: string;
  };
  readonly inboxHttp?: {
    readonly port: number;
    readonly authenticate: InboxAuthenticator;
  };
  /** DSH sees only the selected provider's standard credential alias. */
  readonly launchEnvironment: LaunchEnvironmentSnapshot;
}

/**
 * Reads the neutral executable launch contract. HOB_BRIDGES contains only
 * bridge identity, adapter type, non-secret config, and env-name references;
 * the referenced values are resolved later through the bridge-scoped provider.
 */
export function readHomeHubLaunchConfig(environment: LaunchEnvironment): HomeHubLaunchConfig {
  const dataDirectory = requiredDataDirectory(environment);
  const bridges = parseBridgeEntries(requiredValue(environment, "HOB_BRIDGES"));
  const modelReference = requiredValue(environment, "HOB_MODEL");

  let model: ReturnType<typeof parseModelReference>;
  try {
    model = parseModelReference(modelReference);
  } catch {
    throw new Error("Invalid HOB_MODEL; expected a supported provider/model reference");
  }

  const credentialEnv = providerSetup(model.provider).credentialEnv;
  const apiKey = requiredValue(environment, credentialEnv).trim();
  const inboxHttp = parseInboxHttp(environment.HOB_INBOX_AUTH_TOKEN, environment.HOB_INBOX_PORT);
  const launchEnvironment = createLaunchEnvironmentSnapshot([{
    source: "process",
    values: { [credentialEnv]: apiKey },
  }]);
  const refsByBridge = new Map(bridges.map((entry) => [entry.bridgeId, entry.credentialRefs]));

  return {
    dataDirectory,
    journalDirectory: dataDirectory,
    registryPath: join(dataDirectory, "bridge-registry.sqlite"),
    worldModelPath: join(dataDirectory, "world-model.sqlite"),
    proposalPath: join(dataDirectory, "proposals.sqlite"),
    bridges: bridges.map(({ bridgeId, adapterType, config }) => ({ bridgeId, adapterType, config })),
    bridgeCredentialSource: createBridgeCredentialSource(environment, refsByBridge),
    catalog: createBuiltinBridgeCatalog(),
    agent: { provider: model.provider, model: model.modelId },
    ...(inboxHttp === undefined ? {} : { inboxHttp }),
    launchEnvironment,
  };
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
  for (const [alias, envNameValue] of Object.entries(value)) {
    const envName = nonEmptyString(envNameValue);
    if (alias.trim() === "" || envName === undefined || !ENV_NAME_PATTERN.test(envName)) {
      throw new Error(`Invalid HOB_BRIDGES credentialRef for "${bridgeId}"`);
    }
    refs[alias] = envName;
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
): BridgeAwareCredentialSource {
  return Object.freeze({
    async resolveForBridge(bridgeId: string, alias: string) {
      const refs = refsByBridge.get(bridgeId);
      const envName = refs !== undefined && Object.prototype.hasOwnProperty.call(refs, alias)
        ? refs[alias]
        : undefined;
      if (envName === undefined) return undefined;
      const value = environment[envName];
      return typeof value === "string" && value.trim() !== ""
        ? { kind: "secret_text" as const, value }
        : undefined;
    },
    async describeForBridge(bridgeId: string, alias: string) {
      const refs = refsByBridge.get(bridgeId);
      const envName = refs !== undefined && Object.prototype.hasOwnProperty.call(refs, alias)
        ? refs[alias]
        : undefined;
      if (envName === undefined) return { configured: false };
      const value = environment[envName];
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
