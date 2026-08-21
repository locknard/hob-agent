import { Context } from "@deepseek-ai/cordis";
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment";

import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./home-world-service.js";
import { HomeProposalService } from "./home-proposal-service.js";
import { ArtifactRegistry, type ArtifactRegistryOptions } from "./artifact-registry.js";
import {
  AuthorityCandidateRegistry,
  type AuthorityCandidateRegistryOptions,
} from "./authority-candidate-registry.js";
import { ArtifactPreparationJobRunner } from "./artifact-preparation-job-runner.js";
import {
  createArtifactPipelineComposition,
  type ArtifactPipelineComposition,
} from "./artifact-pipeline-composition.js";
import { HomeRetentionService } from "./home-retention-service.js";
import {
  HomeObservationAuditService,
  type HomeObservationAuditServiceOptions,
} from "./home-observation-audit-service.js";
import {
  HomeObservationSchedulerService,
  type HomeObservationSchedulerOptions,
} from "./home-observation-scheduler.js";
import {
  ProposalStoreError,
  SqliteProposalStore,
  type SqliteProposalStoreOptions,
} from "./proposal-store.js";
import {
  HomeAdviceService,
  type HomeAdviceServiceOptions,
} from "./home-advice-service.js";
import { ProposalInboxService } from "@hob-agent/inbox-web/service";
import {
  ProposalInboxHttpService,
  type ProposalInboxHttpOptions,
} from "@hob-agent/inbox-web/http";
import {
  mountDshHomeAgent,
  type DshHomeAgentCompositionOptions,
} from "@hob-agent/agent-layer/composition";
import {
  HomeMediaCatalogService,
  HomeMediaPlaybackPreparationService,
  HomeMediaPlayerService,
  type HomeMediaCatalogServiceOptions,
} from "./home-media-services.js";

export interface HomeAgentRuntimeOptions {
  readonly homeWorld: HomeWorldServiceOptions;
  readonly homeProposals?: SqliteProposalStoreOptions;
  readonly homeArtifacts?: ArtifactRegistryOptions;
  readonly homeAuthorityCandidates?: AuthorityCandidateRegistryOptions;
  readonly homeObservationAudit?: HomeObservationAuditServiceOptions;
  readonly homeAdvice?: HomeAdviceServiceOptions;
  /** Explicit read-only media catalog. Omit to keep catalog search unavailable. */
  readonly mediaCatalog?: HomeMediaCatalogServiceOptions;
  readonly inboxHttp?: ProposalInboxHttpOptions;
  readonly observation?: HomeObservationSchedulerOptions;
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
  private proposalStore: SqliteProposalStore | undefined;
  private artifactRegistry: ArtifactRegistry | undefined;
  private authorityCandidates: AuthorityCandidateRegistry | undefined;
  private artifactPipeline: ArtifactPipelineComposition | undefined;
  private preparationRunner: ArtifactPreparationJobRunner | undefined;

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
      this.proposalStore = new SqliteProposalStore(this.options.homeProposals ?? { path: ":memory:" });
      this.artifactRegistry = new ArtifactRegistry(this.options.homeArtifacts ?? { path: ":memory:" });
      this.authorityCandidates = new AuthorityCandidateRegistry(
        this.options.homeAuthorityCandidates ?? { path: ":memory:" },
      );
      await this.context.plugin(HomeWorldService, this.options.homeWorld);
      await this.context.plugin(HomeMediaPlayerService);
      await this.context.plugin(
        HomeObservationAuditService,
        this.options.homeObservationAudit ?? { path: ":memory:" },
      );
      await this.context.plugin(HomeProposalService, {
        store: this.proposalStore,
        onPreparationQueued: (job) => {
          const runner = this.preparationRunner;
          if (runner !== undefined) void runner.run(job.jobId, job.version).catch(() => undefined);
        },
      });
      this.artifactPipeline = await createArtifactPipelineComposition({
        context: this.context,
        proposals: this.proposalStore,
        homeWorld: this.context.homeWorld,
        artifacts: this.artifactRegistry,
        authorityCandidates: this.authorityCandidates,
      });
      this.preparationRunner = new ArtifactPreparationJobRunner({
        jobs: this.proposalStore,
        preparation: this.artifactPipeline,
      });
      await this.preparationRunner.start();
      await this.context.plugin(HomeRetentionService);
      if (this.options.mediaCatalog !== undefined) {
        await this.context.plugin(HomeMediaCatalogService, this.options.mediaCatalog);
        await this.context.plugin(HomeMediaPlaybackPreparationService, {
          tenantId: this.options.mediaCatalog.tenantId,
          ...(this.options.mediaCatalog.now === undefined ? {} : { now: this.options.mediaCatalog.now }),
        });
      }
      await mountDshHomeAgent(this.context, this.options.agent);
      await this.context.plugin(HomeAdviceService, this.options.homeAdvice ?? { path: ":memory:" });
      await this.context.plugin(HomeObservationSchedulerService, this.options.observation ?? {});
      await this.context.plugin(ProposalInboxService, {
        preparation: {
          retry: (input) => this.retryPreparation(input),
        },
      });
      if (this.options.inboxHttp !== undefined) {
        await this.context.plugin(ProposalInboxHttpService, this.options.inboxHttp);
      }
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
    this.stopTask = this.disposeRuntime();
    return this.stopTask;
  }

  private async disposeRuntime(): Promise<void> {
    let failure: unknown;
    try {
      await this.preparationRunner?.stop();
      await this.artifactPipeline?.stop();
      await this.context.fiber.dispose();
    } catch (error) {
      failure = error;
    } finally {
      for (const resource of [
        this.authorityCandidates,
        this.artifactRegistry,
        this.proposalStore,
      ]) {
        try {
          resource?.close();
        } catch (error) {
          failure ??= error;
        }
      }
      this.preparationRunner = undefined;
      this.artifactPipeline = undefined;
      this.authorityCandidates = undefined;
      this.artifactRegistry = undefined;
      this.proposalStore = undefined;
      this.statusValue = "stopped";
    }
    if (failure !== undefined) throw failure;
  }

  private retryPreparation(input: {
    readonly proposalId: string;
    readonly expectedRevision: number;
    readonly expectedVersion: number;
  }): void {
    const store = this.proposalStore;
    const runner = this.preparationRunner;
    if (store === undefined || runner === undefined || this.statusValue !== "running") {
      throw new Error("Artifact preparation retry is unavailable");
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new TypeError("Preparation retry proposal revision is invalid");
    }
    const current = store.getPreparationJobForProposal(input.proposalId, input.expectedRevision);
    if (current === undefined) {
      throw new ProposalStoreError("not_found", "Preparation job not found");
    }
    const queued = store.retryPreparationJob({
      jobId: current.jobId,
      expectedVersion: input.expectedVersion,
    });
    void runner.run(queued.jobId, queued.version).catch(() => undefined);
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
