import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

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
  readProductBootstrapLaunchConfig,
  readHomeHubLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";
import { loadActionAuthorityConfiguration } from "./authority/action-authority-config.js";
import type { ActionAuthorityConfiguration } from "./authority/authority-coordinator.js";
import {
  loadSelectedModelCredential,
  type SelectedModelCredential,
} from "./model-credential-profile.js";
import { MusicAssistantMediaCatalogProvider } from "./media/music-assistant-media-provider.js";
import { MusicAssistantWebSocketSearchClient } from "./media/music-assistant-websocket-client.js";
import { ProductBootstrapConfigStore } from "./product-bootstrap-config-store.js";

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
  bridgeCredentialVault?: SecretVault,
): HomeHubProcessOptions {
  const config = readHomeHubLaunchConfig(environment, selectedCredential, bridgeCredentialVault);
  const musicAssistantClient = config.musicAssistant === undefined
    ? undefined
    : new MusicAssistantWebSocketSearchClient({
        baseUrl: config.musicAssistant.baseUrl,
        resolveToken: config.musicAssistant.resolveToken,
      });
  const mediaCatalog = musicAssistantClient === undefined ? undefined : {
    tenantId: "household",
    catalogId: "music-assistant",
    generation: 1,
    sourceLabel: "Music Assistant",
    mediaRefTtlMs: 300_000,
    maxQueryChars: 128,
    maxResults: 3,
    provider: new MusicAssistantMediaCatalogProvider(musicAssistantClient),
  } as const;
  const mediaPlayback = musicAssistantClient === undefined
    || config.musicAssistant?.playerIdForCapability === undefined
    ? undefined
    : {
        tenantId: "household",
        client: musicAssistantClient,
        playerIdForCapability: config.musicAssistant.playerIdForCapability,
      } as const;
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
      homeReviewCenter: { path: config.oneShotActionPath },
      homeBatchActions: { path: config.batchActionPath },
      homeOnboarding: {
        path: config.onboardingPath,
        ...(config.householdDirectory === undefined ? {} : { householdDirectory: config.householdDirectory }),
      },
      homeArtifacts: { path: config.artifactPath },
      homeAuthorityCandidates: { path: config.authorityCandidatePath },
      homeObservationAudit: { path: config.observationAuditPath },
      homeAdvice: { path: config.advicePath },
      homeCorrections: {
        path: join(config.dataDirectory, "home-corrections.sqlite"),
        ...(config.householdDirectory === undefined ? {} : { householdDirectory: config.householdDirectory }),
      },
      homeSafety: { path: config.safetyPath, bindings: config.safetyBindings },
      agent: {
        ...config.agent,
        sessionPersistencePath: config.sessionPath,
        ...(config.householdDirectory === undefined
          ? {}
          : { householdDirectory: config.householdDirectory }),
      },
      ...(config.inboxHttp === undefined ? {} : {
        inboxHttp: { ...config.inboxHttp },
        homeViewRecipeDrafts: { path: join(config.dataDirectory, "layout-drafts.sqlite") },
      }),
      ...(config.observation === undefined ? {} : { observation: config.observation }),
      ...(mediaCatalog === undefined ? {} : { mediaCatalog }),
      ...(mediaPlayback === undefined ? {} : { mediaPlayback }),
      launchEnvironment: config.launchEnvironment,
    },
  };
}

/** Resolves the private selected profile, with env credentials as legacy fallback. */
export async function resolveHomeHubProcessOptions(
  environment: LaunchEnvironment,
  vault?: SecretVault,
): Promise<HomeHubProcessOptions> {
  const { dataDirectory } = readProductBootstrapLaunchConfig(environment);
  const activated = await new ProductBootstrapConfigStore(dataDirectory).load();
  const effectiveEnvironment: LaunchEnvironment = activated === undefined
    ? environment
    : {
        ...environment,
        HOB_MODEL: environment.HOB_MODEL ?? activated.modelReference,
        HOB_MODEL_BASE_URL: environment.HOB_MODEL_BASE_URL
          ?? (environment.HOB_MODEL === undefined ? activated.modelBaseURL : undefined),
        HOB_BRIDGES: environment.HOB_BRIDGES ?? JSON.stringify(activated.bridges),
      };
  const modelReference = effectiveEnvironment.HOB_MODEL?.trim();
  if (!modelReference) {
    return createHomeHubProcessOptions(effectiveEnvironment);
  }
  let provider;
  try {
    provider = parseModelReference(modelReference).provider;
  } catch {
    return createHomeHubProcessOptions(effectiveEnvironment);
  }
  const selectedCredential = await loadSelectedModelCredential(dataDirectory, provider, vault);
  // Validate the complete launch contract before touching the optional
  // authority file so malformed bridge/model input keeps its bounded error.
  readHomeHubLaunchConfig(effectiveEnvironment, selectedCredential, vault);
  const actionAuthorityConfig = await loadActionAuthorityConfigurationIfConfigured(dataDirectory);
  return createHomeHubProcessOptions(effectiveEnvironment, selectedCredential, actionAuthorityConfig, vault);
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
