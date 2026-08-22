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
import { ArtifactRegistry, type ArtifactRegistryOptions } from "./artifact/artifact-registry.js";
import {
  AuthorityCandidateRegistry,
  type AuthorityCandidateRegistryOptions,
} from "./authority/authority-candidate-registry.js";
import { ArtifactPreparationJobRunner } from "./artifact/artifact-preparation-job-runner.js";
import {
  createArtifactPipelineComposition,
  type ArtifactPipelineComposition,
} from "./artifact/artifact-pipeline-composition.js";
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
  HomeMediaPlaybackExecutionService,
  HomeMediaPlaybackPreparationService,
  HomeMediaPlayerService,
  type HomeMediaCatalogServiceOptions,
  type HomeMediaPlaybackExecutionServiceOptions,
} from "./media/home-media-services.js";
import {
  HomeMediaConversationService,
  type HomeMediaConversationServiceOptions,
} from "./media/home-media-conversation-service.js";
import {
  HouseholdReviewCenterService,
  type HouseholdReviewCenterServiceOptions,
} from "./household-review-center-service.js";
import {
  HomeOnboardingCoordinatorService,
  type HomeOnboardingCoordinatorOptions,
} from "./home-onboarding-coordinator.js";
import {
  HomeSafetyService,
  type HomeSafetyServiceOptions,
} from "./home-safety-service.js";
import {
  HomeCorrectionService,
  type HomeCorrectionServiceOptions,
} from "./home-correction-service.js";
import {
  HomeBatchActionService,
  type HomeBatchActionServiceOptions,
} from "./home-batch-action-service.js";
import {
  SqliteProductViewRecipeDraftStore,
  type SqliteProductViewRecipeDraftStoreOptions,
} from "./product-view-recipe-draft-store.js";

export interface HomeAgentRuntimeOptions {
  readonly homeWorld: HomeWorldServiceOptions;
  readonly homeProposals?: SqliteProposalStoreOptions;
  readonly homeArtifacts?: ArtifactRegistryOptions;
  readonly homeAuthorityCandidates?: AuthorityCandidateRegistryOptions;
  readonly homeObservationAudit?: HomeObservationAuditServiceOptions;
  readonly homeAdvice?: HomeAdviceServiceOptions;
  readonly homeReviewCenter?: HouseholdReviewCenterServiceOptions;
  /** Durable Hub-owned batch coordination over the existing one-shot action owner. */
  readonly homeBatchActions?: Omit<HomeBatchActionServiceOptions, "reviewCenter">;
  /** Durable Hub-owned onboarding state and typed step effects. */
  readonly homeOnboarding?: HomeOnboardingCoordinatorOptions;
  /** Explicit Hub-owned safety bindings; each binding names one hwCapabilityId. */
  readonly homeSafety?: HomeSafetyServiceOptions;
  /** Durable Hub-owned completed-conversation correction state and workspace. */
  readonly homeCorrections?: HomeCorrectionServiceOptions;
  /** Explicit read-only media catalog. Omit to keep catalog search unavailable. */
  readonly mediaCatalog?: HomeMediaCatalogServiceOptions;
  /** Explicit governed Music Assistant execution owner for the media action gateway. */
  readonly mediaPlayback?: HomeMediaPlaybackExecutionServiceOptions;
  /** Governed media request orchestration. The runtime mounts it with the catalog and review owner. */
  readonly mediaConversation?: HomeMediaConversationServiceOptions;
  readonly inboxHttp?: ProposalInboxHttpOptions;
  /** Private Hub-owned persistence for layout authoring source drafts. */
  readonly homeViewRecipeDrafts?: SqliteProductViewRecipeDraftStoreOptions;
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
  private viewRecipeDraftStore: SqliteProductViewRecipeDraftStore | undefined;

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
      if (this.options.homeViewRecipeDrafts !== undefined) {
        this.viewRecipeDraftStore = new SqliteProductViewRecipeDraftStore(this.options.homeViewRecipeDrafts);
      }
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
        if (this.options.mediaPlayback !== undefined) {
          await this.context.plugin(HomeMediaPlaybackExecutionService, this.options.mediaPlayback);
        }
      } else if (this.options.mediaPlayback !== undefined) {
        throw new Error("Music Assistant playback requires an explicit media catalog");
      }
      await this.context.plugin(
        HouseholdReviewCenterService,
        {
          ...(this.options.homeReviewCenter ?? { path: ":memory:" }),
          ...(this.options.homeReviewCenter?.actionDescriptorSource === undefined
            ? {
                actionDescriptorSource: {
                  actionDescriptorFor: (capabilityId: string) =>
                    this.context.homeWorld.actionDescriptorFor(capabilityId),
                },
              }
            : {}),
        },
      );
      await this.context.plugin(HomeBatchActionService, {
        ...(this.options.homeBatchActions ?? {}),
        reviewCenter: this.context.homeReviewCenter,
      });
      if (this.options.mediaCatalog !== undefined) {
        await this.context.plugin(HomeMediaConversationService, this.options.mediaConversation ?? {});
      }
      await mountDshHomeAgent(this.context, this.options.agent);
      await this.context.plugin(HomeAdviceService, this.options.homeAdvice ?? { path: ":memory:" });
      if (this.options.homeOnboarding !== undefined) {
        await this.context.plugin(HomeOnboardingCoordinatorService, {
          ...this.options.homeOnboarding,
          ...(this.options.homeOnboarding.actionAuthority === undefined ? {
            actionAuthority: {
              configure: (input) => this.context.homeWorld.configureActionAuthority(input),
            },
          } : {}),
          ...(this.options.homeOnboarding.observation === undefined ? {
            observation: {
              configure: (input) => {
                try {
                  this.context.homeObservationScheduler.configure(input);
                  return { status: "configured" as const };
                } catch {
                  return { status: "blocked" as const, reason: "runtime_configuration_failed" };
                }
              },
            },
          } : {}),
        });
      }
      await this.context.plugin(
        HomeSafetyService,
        this.options.homeSafety ?? { path: ":memory:", bindings: [] },
      );
      if (this.options.homeCorrections !== undefined) {
        await this.context.plugin(HomeCorrectionService, this.options.homeCorrections);
      }
      const observationOptions: HomeObservationSchedulerOptions = {
        ...(this.options.observation ?? {}),
        ...(this.options.homeOnboarding !== undefined
          && this.options.observation?.onboarding === undefined
          ? { onboarding: this.context.homeOnboarding }
          : {}),
      };
      await this.context.plugin(HomeObservationSchedulerService, observationOptions);
      await this.context.plugin(ProposalInboxService, {
        preparation: {
          retry: (input) => this.retryPreparation(input),
        },
      });
      if (this.options.inboxHttp !== undefined) {
        await this.context.plugin(ProposalInboxHttpService, {
          ...this.options.inboxHttp,
          ...(this.viewRecipeDraftStore === undefined ? {} : { viewRecipeDrafts: this.viewRecipeDraftStore }),
        });
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
        this.viewRecipeDraftStore,
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
      this.viewRecipeDraftStore = undefined;
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
