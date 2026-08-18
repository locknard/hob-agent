import { Context } from "@deepseek-ai/cordis";
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment";

import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./home-world-service.js";
import {
  mountDshHomeAgent,
  type DshHomeAgentCompositionOptions,
} from "@hob-agent/agent-layer/composition";

export interface HomeAgentRuntimeOptions {
  readonly homeWorld: HomeWorldServiceOptions;
  readonly agent: DshHomeAgentCompositionOptions;
  readonly launchEnvironment: LaunchEnvironmentSnapshot;
}

export type HomeAgentRuntimeStatus = "created" | "starting" | "running" | "stopping" | "stopped";

/**
 * Owns the process-level Cordis root and the neutral Phase 0 runtime fibers.
 * HomeWorld owns all configured bridge adapters; the DSH Home Agent only sees
 * its neutral service. Disposing the root fiber unloads the Agent before the
 * world runtime, in reverse registration order.
 */
export class HomeAgentRuntime {
  readonly context: Context;
  private statusValue: HomeAgentRuntimeStatus = "created";
  private stopTask: Promise<void> | undefined;

  constructor(private readonly options: HomeAgentRuntimeOptions) {
    this.context = new Context();
    this.context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.launchEnvironment);
  }

  get status(): HomeAgentRuntimeStatus {
    return this.statusValue;
  }

  async start(): Promise<void> {
    if (this.statusValue !== "created") {
      throw new Error(`Home Agent runtime cannot start from ${this.statusValue} state`);
    }
    this.statusValue = "starting";
    try {
      await this.context.plugin(HomeWorldService, this.options.homeWorld);
      await mountDshHomeAgent(this.context, this.options.agent);
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
      () => {
        this.statusValue = "stopped";
      },
      (error: unknown) => {
        this.statusValue = "stopped";
        throw error;
      },
    );
    return this.stopTask;
  }
}

export function createHomeAgentRuntime(options: HomeAgentRuntimeOptions): HomeAgentRuntime {
  return new HomeAgentRuntime(options);
}

export async function startHomeAgentRuntime(options: HomeAgentRuntimeOptions): Promise<HomeAgentRuntime> {
  const runtime = createHomeAgentRuntime(options);
  await runtime.start();
  return runtime;
}
