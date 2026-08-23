import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { parseModelReference } from "@hob-agent/agent-layer/model-reference";
import {
  MacOSKeychainSecretVault,
  type SecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  startHomeAgentProcess,
  startHomeHubProcess,
  type HomeHubRuntime,
  type RunningHomeHubProcess,
  type SignalProcess,
} from "./process-entry.js";
import { mountHomeAgentProductBundle } from "./home-agent-runtime.js";
import {
  readProductBootstrapLaunchConfig,
  readHomeHubLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";
import { loadActionAuthorityConfiguration } from "./authority/action-authority-config.js";
import type { ActionAuthorityConfiguration } from "./authority/authority-coordinator.js";
import {
  builtinBridgeProductBundle,
  createBuiltinBridgeCatalog,
  type BridgeProductBundle,
} from "./bridge/bridge-bundle.js";
import {
  loadSelectedModelCredential,
  type SelectedModelCredential,
} from "./model-credential-profile.js";
import { MusicAssistantMediaCatalogProvider } from "./media/music-assistant-media-provider.js";
import { MusicAssistantWebSocketSearchClient } from "./media/music-assistant-websocket-client.js";
import {
  ProductBootstrapConfigStore,
  type ProductBootstrapConfigDraft,
} from "./product-bootstrap-config-store.js";
import {
  DEFAULT_PRODUCT_SETUP_PORT,
  startProductRuntimeSupervisor,
  type ProductSessionRecoveryAnnouncement,
  type ProductSetupAnnouncement,
  type ProductRuntimeSupervisorOptions,
} from "./product-runtime-supervisor.js";

type ActionAuthorityConfig = Readonly<Record<string, ActionAuthorityConfiguration>>;

export interface HomeHubMainOptions {
  readonly env?: LaunchEnvironment;
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
  /** Test seam for the unified setup and operational product composition root. */
  readonly createProductRuntime?: (options: ProductRuntimeSupervisorOptions) => Promise<HomeHubRuntime> | HomeHubRuntime;
  /** Test seam for the operational product bundle mounted below the supervisor's Cordis root. */
  readonly mountProductBundle?: typeof mountHomeAgentProductBundle;
  /** Test seam; production resolves selected profiles from macOS Keychain. */
  readonly modelCredentialVault?: WritableSecretVault;
  /** Local terminal presentation for the short-lived setup and recovery pairing codes. */
  readonly writeProductTerminal?: (message: string) => void;
  /** The single bridge inventory shared by setup and every mounted generation. */
  readonly bridgeProductBundle?: BridgeProductBundle;
}

export interface HomeHubProcessOptions {
  readonly runtime: Parameters<typeof startHomeAgentProcess>[0]["runtime"];
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
}

export type ProductLaunchSelection =
  | { readonly state: "setup"; readonly dataDirectory: string }
  | { readonly state: "operational"; readonly dataDirectory: string; readonly activatedGeneration?: number };

interface PreparedProductLaunch {
  readonly selection: ProductLaunchSelection;
  readonly activated?: Awaited<ReturnType<ProductBootstrapConfigStore["load"]>>;
}

/** Classifies the process lifecycle using non-secret configuration metadata. */
export async function resolveProductLaunchSelection(
  environment: LaunchEnvironment,
): Promise<ProductLaunchSelection> {
  return (await prepareProductLaunch(environment)).selection;
}

/** Converts the explicit launch environment into the root composition input. */
export function createHomeHubProcessOptions(
  environment: LaunchEnvironment,
  selectedCredential?: SelectedModelCredential,
  actionAuthorityConfig: ActionAuthorityConfig = Object.freeze({}),
  bridgeCredentialVault?: SecretVault,
  bridgeProductBundle?: BridgeProductBundle,
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
        catalog: bridgeProductBundle === undefined ? config.catalog : createBuiltinBridgeCatalog(bridgeProductBundle),
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
      ...(mediaCatalog === undefined ? {} : {
        mediaCatalog,
        homeMediaActionTurns: { path: join(config.dataDirectory, "home-media-action-turns.sqlite") },
      }),
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
  const prepared = await prepareProductLaunch(environment);
  const { dataDirectory } = prepared.selection;
  const activated = prepared.activated;
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
  const selectedCredential = activated !== undefined && environment.HOB_MODEL === undefined
    ? { profile: activated.modelProfile, vault: vault ?? new MacOSKeychainSecretVault() }
    : await loadSelectedModelCredential(dataDirectory, provider, vault);
  // Validate the complete launch contract before touching the optional
  // authority file so malformed bridge/model input keeps its bounded error.
  readHomeHubLaunchConfig(effectiveEnvironment, selectedCredential, vault);
  const actionAuthorityConfig = await loadActionAuthorityConfigurationIfConfigured(dataDirectory);
  return createHomeHubProcessOptions(effectiveEnvironment, selectedCredential, actionAuthorityConfig, vault);
}

/** Builds an operational candidate from the exact map revision that setup verified. */
async function resolveCandidateHomeHubProcessOptions(
  environment: LaunchEnvironment,
  dataDirectory: string,
  candidate: ProductBootstrapConfigDraft,
  vault?: SecretVault,
  bridgeProductBundle?: BridgeProductBundle,
): Promise<HomeHubProcessOptions> {
  const effectiveEnvironment: LaunchEnvironment = {
    ...environment,
    HOB_MODEL: candidate.modelReference,
    HOB_MODEL_BASE_URL: candidate.modelBaseURL,
    HOB_BRIDGES: JSON.stringify(candidate.bridges),
  };
  const secretVault = vault ?? new MacOSKeychainSecretVault();
  const selectedCredential: SelectedModelCredential = {
    profile: candidate.modelProfile,
    vault: secretVault,
  };
  readHomeHubLaunchConfig(effectiveEnvironment, selectedCredential, secretVault);
  const actionAuthorityConfig = await loadActionAuthorityConfigurationIfConfigured(dataDirectory);
  return createHomeHubProcessOptions(
    effectiveEnvironment,
    selectedCredential,
    actionAuthorityConfig,
    secretVault,
    bridgeProductBundle,
  );
}

async function prepareProductLaunch(environment: LaunchEnvironment): Promise<PreparedProductLaunch> {
  const { dataDirectory } = readProductBootstrapLaunchConfig(environment);
  const activated = await new ProductBootstrapConfigStore(dataDirectory).load();
  if (activated === undefined) {
    return { selection: { state: "setup", dataDirectory } };
  }
  return {
    selection: {
      state: "operational",
      dataDirectory,
      ...(activated === undefined ? {} : { activatedGeneration: activated.generation }),
    },
    ...(activated === undefined ? {} : { activated }),
  };
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
  const environment = options.env ?? process.env;
  const prepared = await prepareProductLaunch(environment);
  const lifecycle = {
    signalProcess: options.signalProcess,
    forceExit: options.forceExit,
    complete: options.complete,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  };
  const dataDirectory = prepared.selection.dataDirectory;
  const mountProductBundle = options.mountProductBundle ?? mountHomeAgentProductBundle;
  const writeProductTerminal = options.writeProductTerminal ?? ((message: string) => { process.stdout.write(message); });
  const productModelCredentialVault = options.modelCredentialVault ?? new MacOSKeychainSecretVault();
  const bridgeProductBundle = options.bridgeProductBundle ?? builtinBridgeProductBundle;
  const productOptions: ProductRuntimeSupervisorOptions = {
    dataDirectory,
    port: productSetupPort(environment.HOB_SETUP_PORT),
    modelCredentialVault: productModelCredentialVault,
    bridgeProductBundle,
    announce: (announcement) => writeProductTerminal(renderProductPairingAnnouncement("setup", announcement)),
    announceRecovery: (announcement) => writeProductTerminal(renderProductPairingAnnouncement("recovery", announcement)),
    mountOperational: async (input) => {
      const processOptions = await resolveCandidateHomeHubProcessOptions(
        environment,
        dataDirectory,
        input.candidate,
        productModelCredentialVault,
        bridgeProductBundle,
      );
      const bundle = await mountProductBundle(input.context, {
        ...processOptions.runtime,
        agent: {
          ...processOptions.runtime.agent,
          modelProviderResolver: input.modelProviderResolver,
        },
        inboxHttp: {
          host: input.host,
          requestAuthenticator: input.authenticateProductSession,
          sessionRecovery: input.recoverProductSession,
          principal: PRODUCT_HOUSEHOLD_ACTOR,
          privateVoice: input.privateVoice,
          voiceSettings: input.voiceSettings,
          modelSettings: input.modelSettings,
        },
        homeViewRecipeDrafts: { path: join(dataDirectory, "layout-drafts.sqlite") },
        homeOnboarding: {
          ...processOptions.runtime.homeOnboarding,
          bootstrapHousehold: {
            householdName: input.candidate.householdName,
            agentName: input.candidate.agentName,
          },
        },
      });
      return {
        attach: () => bundle.context.homeInboxHttp.attach(),
        dispose: () => bundle.dispose(),
      };
    },
  };
  return startHomeHubProcess({
    ...lifecycle,
    createRuntime: () => options.createProductRuntime?.(productOptions)
      ?? startProductRuntimeSupervisor(productOptions),
  });
}

const PRODUCT_HOUSEHOLD_ACTOR = Object.freeze({
  principalId: "household-owner",
  role: "adult_member" as const,
  present: true,
  device: {
    kind: "private" as const,
    boundPrincipalId: "household-owner",
  },
});

function renderProductPairingAnnouncement(
  purpose: "setup" | "recovery",
  announcement: ProductSetupAnnouncement | ProductSessionRecoveryAnnouncement,
): string {
  const path = purpose === "setup" ? "/setup" : "/pair";
  const title = purpose === "setup" ? "Hob 本机设置配对" : "Hob 本机会话恢复";
  return `\n${title}\n打开：${announcement.origin}${path}\n配对码：${announcement.pairingCode}\n有效至：${announcement.expiresAt.toISOString()}\n`;
}

function productSetupPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PRODUCT_SETUP_PORT;
  if (!/^\d{1,5}$/.test(value.trim())) throw new TypeError("HOB_SETUP_PORT must be an integer from 0 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("HOB_SETUP_PORT must be an integer from 0 to 65535");
  }
  return port;
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void main().catch(() => {
    // Do not print arbitrary startup errors: they may contain a credential
    // supplied by a model provider or bridge.
    console.error("hob-agent failed to start");
    process.exitCode = 1;
  });
}

export type { HomeHubRuntime };
