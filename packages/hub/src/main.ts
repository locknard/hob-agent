import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { parseModelReference } from "@hob-agent/agent-layer/model-reference";
import type { SecretVault } from "@hob-agent/agent-layer/model-credentials";

import {
  startHomeAgentProcess,
  startHomeHubProcess,
  type HomeHubRuntime,
  type RunningHomeHubProcess,
  type SignalProcess,
  type StartHomeHubProcessOptions,
} from "./process-entry.js";
import {
  readHomeHubLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";
import { loadActionAuthorityConfiguration } from "./action-authority-config.js";
import type { ActionAuthorityConfiguration } from "./authority-coordinator.js";
import {
  loadSelectedModelCredential,
  type SelectedModelCredential,
} from "./model-credential-profile.js";

type ActionAuthorityConfig = Readonly<Record<string, ActionAuthorityConfiguration>>;

export interface HomeHubMainOptions {
  readonly env?: LaunchEnvironment;
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
  /** Test seam; production uses the repository's DSH composition root. */
  readonly createRuntime?: StartHomeHubProcessOptions["createRuntime"];
  /** Test seam; production resolves selected profiles from macOS Keychain. */
  readonly modelCredentialVault?: SecretVault;
}

export interface HomeHubProcessOptions {
  readonly runtime: Parameters<typeof startHomeAgentProcess>[0]["runtime"];
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
}

/** Converts the explicit launch environment into the root composition input. */
export function createHomeHubProcessOptions(
  environment: LaunchEnvironment,
  selectedCredential?: SelectedModelCredential,
  actionAuthorityConfig: ActionAuthorityConfig = Object.freeze({}),
): HomeHubProcessOptions {
  const config = readHomeHubLaunchConfig(environment, selectedCredential);
  return {
    runtime: {
      homeWorld: {
        catalog: config.catalog,
        bridges: config.bridges,
        credentialSource: config.bridgeCredentialSource,
        journalDirectory: config.journalDirectory,
        registryPath: config.registryPath,
        worldModelPath: config.worldModelPath,
        actionAuthorityConfig,
      },
      homeProposals: { path: config.proposalPath },
      homeArtifacts: { path: config.artifactPath },
      homeAuthorityCandidates: { path: config.authorityCandidatePath },
      homeObservationAudit: { path: config.observationAuditPath },
      homeAdvice: { path: config.advicePath },
      agent: {
        ...config.agent,
        sessionPersistencePath: config.sessionPath,
        ...(config.householdDirectory === undefined
          ? {}
          : { householdDirectory: config.householdDirectory }),
      },
      ...(config.inboxHttp === undefined ? {} : { inboxHttp: config.inboxHttp }),
      ...(config.observation === undefined ? {} : { observation: config.observation }),
      launchEnvironment: config.launchEnvironment,
    },
  };
}

/** Resolves the private selected profile, with env credentials as legacy fallback. */
export async function resolveHomeHubProcessOptions(
  environment: LaunchEnvironment,
  vault?: SecretVault,
): Promise<HomeHubProcessOptions> {
  const dataDirectory = environment.HOB_DATA_DIR?.trim();
  const modelReference = environment.HOB_MODEL?.trim();
  if (dataDirectory === undefined || !isAbsolute(dataDirectory) || !modelReference) {
    return createHomeHubProcessOptions(environment);
  }
  let provider;
  try {
    provider = parseModelReference(modelReference).provider;
  } catch {
    return createHomeHubProcessOptions(environment);
  }
  const selectedCredential = await loadSelectedModelCredential(dataDirectory, provider, vault);
  // Validate the complete launch contract before touching the optional
  // authority file so malformed bridge/model input keeps its bounded error.
  readHomeHubLaunchConfig(environment, selectedCredential);
  const actionAuthorityConfig = await loadActionAuthorityConfigurationIfConfigured(dataDirectory);
  return createHomeHubProcessOptions(environment, selectedCredential, actionAuthorityConfig);
}

async function loadActionAuthorityConfigurationIfConfigured(
  dataDirectory: string,
): Promise<ActionAuthorityConfig> {
  try {
    await lstat(dataDirectory);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return Object.freeze({});
    throw error;
  }
  return loadActionAuthorityConfiguration(dataDirectory);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

/** Starts the one executable Home Hub process after validating its launch env. */
export async function main(options: HomeHubMainOptions = {}): Promise<RunningHomeHubProcess> {
  const processOptions = await resolveHomeHubProcessOptions(
    options.env ?? process.env,
    options.modelCredentialVault,
  );
  const lifecycle = {
    signalProcess: options.signalProcess,
    forceExit: options.forceExit,
    complete: options.complete,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  };
  if (options.createRuntime) {
    return startHomeHubProcess({
      ...processOptions,
      ...lifecycle,
      createRuntime: options.createRuntime,
    });
  }
  return startHomeAgentProcess({ ...processOptions, ...lifecycle });
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void main().catch(() => {
    // Do not print arbitrary startup errors: they may contain a credential
    // supplied by a provider or Home Assistant.
    console.error("hob-agent failed to start");
    process.exitCode = 1;
  });
}

export type { HomeHubRuntime };
