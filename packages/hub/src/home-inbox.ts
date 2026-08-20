import { Context } from "@deepseek-ai/cordis";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  ProposalInboxHttpService,
  type ProposalInboxHttpOptions,
} from "@hob-agent/inbox-web/http";
import { ProposalInboxService } from "@hob-agent/inbox-web/service";

import { HomeProposalService } from "./home-proposal-service.js";
import {
  HomeObservationAuditService,
  type HomeObservationAuditServiceOptions,
} from "./home-observation-audit-service.js";
import {
  readHomeInboxLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";
import {
  startHomeHubProcess,
  type HomeHubRuntime,
  type RunningHomeHubProcess,
  type SignalProcess,
} from "./process-entry.js";
import type { SqliteProposalStoreOptions } from "./proposal-store.js";
import {
  HomeAdviceService,
  type HomeAdviceServiceOptions,
} from "./home-advice-service.js";

export interface HomeInboxRuntimeOptions {
  readonly homeProposals: SqliteProposalStoreOptions;
  readonly homeObservationAudit: HomeObservationAuditServiceOptions;
  readonly homeAdvice: HomeAdviceServiceOptions;
  readonly inboxHttp: ProposalInboxHttpOptions;
}

export type HomeInboxRuntimeStatus = "created" | "starting" | "running" | "stopping" | "stopped";

/** A proposal-review composition with no bridge, model, or Agent lifecycle. */
export class HomeInboxRuntime implements HomeHubRuntime {
  readonly context = new Context();
  private statusValue: HomeInboxRuntimeStatus = "created";
  private stopTask: Promise<void> | undefined;

  constructor(private readonly options: HomeInboxRuntimeOptions) {}

  get status(): HomeInboxRuntimeStatus {
    return this.statusValue;
  }

  async start(): Promise<void> {
    if (this.statusValue !== "created") {
      throw new Error(`Home Inbox runtime cannot start from ${this.statusValue} state`);
    }
    this.statusValue = "starting";
    try {
      await this.context.plugin(HomeProposalService, this.options.homeProposals);
      await this.context.plugin(HomeObservationAuditService, this.options.homeObservationAudit);
      await this.context.plugin(HomeAdviceService, this.options.homeAdvice);
      await this.context.plugin(ProposalInboxService);
      await this.context.plugin(ProposalInboxHttpService, this.options.inboxHttp);
      this.statusValue = "running";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped") return;
    if (this.stopTask) return this.stopTask;
    this.statusValue = "stopping";
    this.stopTask = this.context.fiber.dispose().then(
      () => { this.statusValue = "stopped"; },
      (error: unknown) => {
        this.statusValue = "stopped";
        throw error;
      },
    );
    return this.stopTask;
  }
}

export function createHomeInboxRuntime(options: HomeInboxRuntimeOptions): HomeInboxRuntime {
  return new HomeInboxRuntime(options);
}

export function createHomeInboxProcessOptions(environment: LaunchEnvironment): HomeInboxRuntimeOptions {
  const config = readHomeInboxLaunchConfig(environment);
  return {
    homeProposals: { path: config.proposalPath },
    homeObservationAudit: { path: config.observationAuditPath },
    homeAdvice: { path: config.advicePath },
    inboxHttp: config.inboxHttp,
  };
}

export interface HomeInboxMainOptions {
  readonly env?: LaunchEnvironment;
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
  readonly createRuntime?: (options: HomeInboxRuntimeOptions) => Promise<HomeHubRuntime> | HomeHubRuntime;
}

/** Starts authenticated localhost review over the durable proposal store only. */
export function main(options: HomeInboxMainOptions = {}): Promise<RunningHomeHubProcess> {
  const runtimeOptions = createHomeInboxProcessOptions(options.env ?? process.env);
  return startHomeHubProcess({
    createRuntime: () => options.createRuntime?.(runtimeOptions)
      ?? startHomeInboxRuntime(runtimeOptions),
    signalProcess: options.signalProcess,
    forceExit: options.forceExit,
    complete: options.complete,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
}

async function startHomeInboxRuntime(options: HomeInboxRuntimeOptions): Promise<HomeInboxRuntime> {
  const runtime = createHomeInboxRuntime(options);
  await runtime.start();
  return runtime;
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void main().then(
    ({ runtime }) => console.log(JSON.stringify({ origin: runtime.context.homeInboxHttp.origin })),
    () => {
      console.error("hob-agent standalone Inbox failed to start");
      process.exitCode = 1;
    },
  );
}
