import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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

export interface HomeHubMainOptions {
  readonly env?: LaunchEnvironment;
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
  /** Test seam; production uses the repository's DSH composition root. */
  readonly createRuntime?: StartHomeHubProcessOptions["createRuntime"];
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
): HomeHubProcessOptions {
  const config = readHomeHubLaunchConfig(environment);
  return {
    runtime: {
      homeWorld: {
        catalog: config.catalog,
        bridges: config.bridges,
        credentialSource: config.bridgeCredentialSource,
        journalDirectory: config.journalDirectory,
        registryPath: config.registryPath,
        worldModelPath: config.worldModelPath,
      },
      homeProposals: { path: config.proposalPath },
      agent: {
        ...config.agent,
        sessionPersistencePath: config.sessionPath,
      },
      ...(config.inboxHttp === undefined ? {} : { inboxHttp: config.inboxHttp }),
      launchEnvironment: config.launchEnvironment,
    },
  };
}

/** Starts the one executable Home Hub process after validating its launch env. */
export async function main(options: HomeHubMainOptions = {}): Promise<RunningHomeHubProcess> {
  const processOptions = createHomeHubProcessOptions(options.env ?? process.env);
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
