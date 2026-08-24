import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment";

import {
  HomeWorldService,
  type HomeWorldServiceOptions,
} from "./world/home-world-service.js";
import { BridgeAutomationDeployment } from "./home/bridge-automation-deployment.js";
import { HomeAutomationMigrationDeployment } from "./home/home-automation-migration-deployment.js";
import { HomeProposalService } from "./home/home-proposal-service.js";
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
import { HomeRetentionService } from "./home/home-retention-service.js";
import { HomeArtifactService } from "./home/home-artifact-service.js";
import {
  HomeObservationAuditService,
  type HomeObservationAuditServiceOptions,
} from "./home/home-observation-audit-service.js";
import {
  HomeObservationSchedulerService,
  type HomeObservationSchedulerOptions,
} from "./home/home-observation-scheduler.js";
import {
  ProposalStoreError,
  SqliteProposalStore,
  type ArtifactPreparationJob,
  type SqliteProposalStoreOptions,
} from "./home/proposal-store.js";
import {
  HomeAdviceService,
  type HomeAdviceServiceOptions,
} from "./home/home-advice-service.js";
import {
  ProposalInboxService,
  type InboxPreparationRetryInput,
  type InboxReviewActor,
  type ProposalInboxMigrationSelection,
  type ProposalInboxMigrationSelectionPort,
  type ProposalInboxMigrationSelectionPrepareResult,
} from "@hob-agent/inbox-web/service";
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
  HomeMediaActionTurnService,
  type HomeMediaActionTurnServiceOptions,
} from "./media/home-media-action-turn-service.js";
import {
  HouseholdReviewCenterService,
  type HouseholdReviewCenterServiceOptions,
} from "./home/household-review-center-service.js";
import {
  HomeOnboardingCoordinatorService,
  type OnboardingActionAuthorityPort,
  type HomeOnboardingCoordinatorOptions,
  type OnboardingObservationPort,
} from "./home/home-onboarding-coordinator.js";
import {
  HomeSafetyService,
  type HomeSafetyServiceOptions,
} from "./home/home-safety-service.js";
import {
  HomeCorrectionService,
  type HomeCorrectionServiceOptions,
} from "./home/home-correction-service.js";
import {
  HomeBatchActionService,
  type HomeBatchActionServiceOptions,
} from "./home/home-batch-action-service.js";
import {
  SqliteProductViewRecipeDraftStore,
  type SqliteProductViewRecipeDraftStoreOptions,
} from "./home/product-view-recipe-draft-store.js";
import {
  HomeAutomationMigrationRuntimeService,
  type HomeAutomationMigrationRuntimeServiceOptions,
} from "./home/home-automation-migration-runtime-service.js";
import type {
  HomeAutomationMigrationSelectionPrincipal,
  HomeAutomationMigrationSelectionProjection,
} from "./home/home-automation-migration-selection.js";

/** The only runtime methods exposed to the structural Inbox adapter. */
export interface HomeAutomationMigrationSelectionInboxRuntimePort {
  listMigrationSelections(
    principal: HomeAutomationMigrationSelectionPrincipal,
  ): readonly HomeAutomationMigrationSelectionProjection[];
  submitMigrationSelection(
    token: string,
    principal: HomeAutomationMigrationSelectionPrincipal,
  ): Promise<HomeAutomationMigrationSelectionProjection>;
}

/**
 * Adapts the Hub-owned selection facade to Inbox's presentation-only seam.
 * Inbox remains the presence gate; this adapter maps only the authenticated
 * principal and private-device binding, never raw assessment identity.
 */
export function createHomeAutomationMigrationSelectionInboxPort(
  runtime: HomeAutomationMigrationSelectionInboxRuntimePort,
): ProposalInboxMigrationSelectionPort {
  return {
    list(actor: InboxReviewActor): readonly ProposalInboxMigrationSelection[] {
      try {
        const principal = selectionPrincipalFromInboxActor(actor);
        return runtime.listMigrationSelections(principal)
          .map((selection) => projectInboxMigrationSelection(selection, principal.privateDeviceBinding === "verified"))
          .filter((selection): selection is ProposalInboxMigrationSelection => selection !== undefined);
      } catch {
        return [];
      }
    },
    async prepare(input: {
      readonly selectionToken: string;
      readonly actor: InboxReviewActor;
    }): Promise<ProposalInboxMigrationSelectionPrepareResult> {
      try {
        const result = await runtime.submitMigrationSelection(
          input.selectionToken,
          selectionPrincipalFromInboxActor(input.actor),
        );
        if (result.status === "prepared" && isBoundedMigrationProposalId(result.proposalId)) {
          return { status: "prepared", proposalId: result.proposalId };
        }
      } catch {
        // The Inbox sees one fixed unavailable outcome for malformed or stale
        // selection claims; Hub keeps the durable reason in its owner store.
      }
      return { status: "unavailable" };
    },
  };
}

function selectionPrincipalFromInboxActor(actor: InboxReviewActor): HomeAutomationMigrationSelectionPrincipal {
  return {
    principalId: actor.principalId,
    role: actor.role,
    privateDeviceBinding: actor.device.kind === "private"
      && actor.device.boundPrincipalId === actor.principalId
      ? "verified"
      : "unverified",
  };
}

function projectInboxMigrationSelection(
  value: HomeAutomationMigrationSelectionProjection,
  allowToken: boolean,
): ProposalInboxMigrationSelection | undefined {
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 200) return undefined;
  if (value.status === "selectable") {
    return allowToken && typeof value.token === "string" && /^[a-f0-9]{32}$/u.test(value.token)
      ? { name: value.name, status: "selectable", token: value.token }
      : { name: value.name, status: "selectable" };
  }
  if (value.status === "prepared" && isBoundedMigrationProposalId(value.proposalId)) {
    return { name: value.name, status: "prepared", proposalId: value.proposalId };
  }
  return { name: value.name, status: "unavailable" };
}

function isBoundedMigrationProposalId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

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
  /** Durable owner for explicit media action turns. Requires an explicit media catalog. */
  readonly homeMediaActionTurns?: Pick<HomeMediaActionTurnServiceOptions, "path">;
  readonly inboxHttp?: ProposalInboxHttpOptions;
  /** Private Hub-owned persistence for layout authoring source drafts. */
  readonly homeViewRecipeDrafts?: SqliteProductViewRecipeDraftStoreOptions;
  /** Private Hub-owned persistence for read-only foreign-rule migration assessments. */
  readonly homeAutomationMigrations?: HomeAutomationMigrationRuntimeServiceOptions;
  readonly observation?: HomeObservationSchedulerOptions;
  readonly agent: DshHomeAgentCompositionOptions;
  readonly launchEnvironment: LaunchEnvironmentSnapshot;
}

export type HomeAgentRuntimeStatus = "created" | "starting" | "running" | "stopping" | "stopped";

/**
 * Owns the product fibers and private resources mounted below one Cordis context.
 * HomeWorld owns all configured bridge adapters; the DSH Home Agent only sees
 * its neutral service. The legacy runtime supplies a private root, while the
 * product bundle supplies a child fiber of its host context.
 */
class HomeAgentProductBundleRuntime {
  private statusValue: HomeAgentRuntimeStatus = "created";
  private stopTask: Promise<void> | undefined;
  private readonly mountedFibers: Fiber[] = [];
  private proposalStore: SqliteProposalStore | undefined;
  private artifactRegistry: ArtifactRegistry | undefined;
  private authorityCandidates: AuthorityCandidateRegistry | undefined;
  private artifactPipeline: ArtifactPipelineComposition | undefined;
  private preparationRunner: ArtifactPreparationJobRunner | undefined;
  private viewRecipeDraftStore: SqliteProductViewRecipeDraftStore | undefined;

  constructor(
    readonly context: Context,
    private readonly options: HomeAgentRuntimeOptions,
  ) {
    this.context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.launchEnvironment);
  }

  get status(): HomeAgentRuntimeStatus {
    return this.statusValue;
  }

  async start(disposeContextOnFailure = false): Promise<void> {
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
      await this.mount(HomeWorldService, this.options.homeWorld);
      await this.mount(
        HomeAutomationMigrationRuntimeService,
        this.options.homeAutomationMigrations ?? { path: ":memory:" },
      );
      await this.mount(HomeMediaPlayerService);
      await this.mount(
        HomeObservationAuditService,
        this.options.homeObservationAudit ?? { path: ":memory:" },
      );
      await this.mount(HomeProposalService, {
        store: this.proposalStore,
        onPreparationQueued: (job: ArtifactPreparationJob) => {
          const runner = this.preparationRunner;
          if (runner !== undefined) void runner.run(job.jobId, job.version).catch(() => undefined);
        },
        deployment: new HomeAutomationMigrationDeployment(
          new BridgeAutomationDeployment(this.service<HomeWorldService>("homeWorld")),
          this.service<HomeAutomationMigrationRuntimeService>("homeAutomationMigrations"),
          this.service<HomeWorldService>("homeWorld"),
        ),
      });
      // Proposal ownership is mounted before restart recovery. Recovery is
      // lookup-only and bounded by the migration facade; a stale/corrupt row
      // cannot prevent the product bundle from starting.
      void this.service<HomeAutomationMigrationRuntimeService>("homeAutomationMigrations")
        .recoverMigrationSelections()
        .catch(() => undefined);
      await this.mount(HomeArtifactService, { registry: this.artifactRegistry });
      this.artifactPipeline = await createArtifactPipelineComposition({
        context: this.context,
        proposals: this.proposalStore,
        homeWorld: this.service<HomeWorldService>("homeWorld"),
        artifacts: this.artifactRegistry,
        authorityCandidates: this.authorityCandidates,
      });
      this.preparationRunner = new ArtifactPreparationJobRunner({
        jobs: this.proposalStore,
        preparation: this.artifactPipeline,
      });
      await this.preparationRunner.start();
      void this.service<HomeProposalService>("homeProposals").reconcileAutomations().catch(() => undefined);
      await this.mount(HomeRetentionService);
      if (this.options.mediaCatalog !== undefined) {
        await this.mount(HomeMediaCatalogService, this.options.mediaCatalog);
        await this.mount(HomeMediaPlaybackPreparationService, {
          tenantId: this.options.mediaCatalog.tenantId,
          ...(this.options.mediaCatalog.now === undefined ? {} : { now: this.options.mediaCatalog.now }),
        });
        if (this.options.mediaPlayback !== undefined) {
          await this.mount(HomeMediaPlaybackExecutionService, this.options.mediaPlayback);
        }
      } else if (this.options.mediaPlayback !== undefined) {
        throw new Error("Music Assistant playback requires an explicit media catalog");
      }
      await this.mount(
        HouseholdReviewCenterService,
        {
          ...(this.options.homeReviewCenter ?? { path: ":memory:" }),
          ...(this.options.homeReviewCenter?.actionDescriptorSource === undefined
            ? {
                actionDescriptorSource: {
                  actionDescriptorFor: (capabilityId: string) =>
                    this.service<HomeWorldService>("homeWorld").actionDescriptorFor(capabilityId),
                },
              }
            : {}),
        },
      );
      await this.mount(HomeBatchActionService, {
        ...(this.options.homeBatchActions ?? {}),
        reviewCenter: this.service<HouseholdReviewCenterService>("homeReviewCenter"),
      });
      if (this.options.mediaCatalog !== undefined) {
        await this.mount(HomeMediaConversationService, this.options.mediaConversation ?? {});
      } else if (this.options.homeMediaActionTurns !== undefined) {
        throw new Error("Media action turns require an explicit media catalog");
      }
      this.mountedFibers.push(await mountDshHomeAgent(this.context, this.options.agent));
      if (this.options.homeMediaActionTurns !== undefined) {
        await this.mount(HomeMediaActionTurnService, this.options.homeMediaActionTurns);
      }
      await this.mount(HomeAdviceService, this.options.homeAdvice ?? { path: ":memory:" });
      if (this.options.homeOnboarding !== undefined) {
        await this.mount(HomeOnboardingCoordinatorService, {
          ...this.options.homeOnboarding,
          ...(this.options.homeOnboarding.actionAuthority === undefined ? {
            actionAuthority: {
              configure: (input: Parameters<OnboardingActionAuthorityPort["configure"]>[0]) =>
                this.service<HomeWorldService>("homeWorld").configureActionAuthority(input),
              configureDelta: (changes: Parameters<NonNullable<OnboardingActionAuthorityPort["configureDelta"]>>[0]) =>
                this.service<HomeWorldService>("homeWorld").configureActionAuthorityDelta(changes),
            },
          } : {}),
          ...(this.options.homeOnboarding.observation === undefined ? {
            observation: {
              configure: (input: Parameters<OnboardingObservationPort["configure"]>[0]) => {
                try {
                  this.service<HomeObservationSchedulerService>("homeObservationScheduler").configure(input);
                  return { status: "configured" as const };
                } catch {
                  return { status: "blocked" as const, reason: "runtime_configuration_failed" };
                }
              },
            },
          } : {}),
        });
      }
      await this.mount(
        HomeSafetyService,
        this.options.homeSafety ?? { path: ":memory:", bindings: [] },
      );
      if (this.options.homeCorrections !== undefined) {
        await this.mount(HomeCorrectionService, this.options.homeCorrections);
      }
      const observationOptions: HomeObservationSchedulerOptions = {
        ...(this.options.observation ?? {}),
        ...(this.options.homeOnboarding !== undefined
          && this.options.observation?.onboarding === undefined
          ? { onboarding: this.service<HomeOnboardingCoordinatorService>("homeOnboarding") }
          : {}),
      };
      await this.mount(HomeObservationSchedulerService, observationOptions);
      await this.mount(ProposalInboxService, {
        preparation: {
          retry: (input: InboxPreparationRetryInput) => this.retryPreparation(input),
        },
        migrationSelection: createHomeAutomationMigrationSelectionInboxPort(
          this.service<HomeAutomationMigrationRuntimeService>("homeAutomationMigrations"),
        ),
      });
      if (this.options.inboxHttp !== undefined) {
        await this.mount(ProposalInboxHttpService, {
          ...this.options.inboxHttp,
          ...(this.viewRecipeDraftStore === undefined ? {} : { viewRecipeDrafts: this.viewRecipeDraftStore }),
        });
      }
      this.statusValue = "running";
    } catch (error) {
      await this.stop(disposeContextOnFailure);
      throw error;
    }
  }

  async stop(disposeContext: boolean): Promise<void> {
    if (this.statusValue === "stopped") return;
    if (this.stopTask) return this.stopTask;

    this.statusValue = "stopping";
    this.stopTask = this.disposeRuntime(disposeContext);
    return this.stopTask;
  }

  private async mount(plugin: Plugin, options?: unknown): Promise<void> {
    const fiber = options === undefined
      ? await this.context.plugin(plugin)
      : await this.context.plugin(plugin, options as never);
    this.mountedFibers.push(fiber);
  }

  private service<T>(name: string): T {
    const service = this.context.get(name);
    if (service === undefined) throw new Error(`Home Agent product service ${name} is unavailable`);
    return service as T;
  }

  private async disposeRuntime(disposeContext: boolean): Promise<void> {
    let failure: unknown;
    try {
      await this.preparationRunner?.stop();
      await this.artifactPipeline?.stop();
      if (disposeContext) {
        await this.context.fiber.dispose();
      } else {
        await Promise.all(this.mountedFibers.splice(0).reverse().map((fiber) => fiber.dispose()));
      }
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

export interface MountedHomeAgentProductBundle {
  readonly context: Context;
  readonly status: HomeAgentRuntimeStatus;
  dispose(): Promise<void>;
}

class MountedHomeAgentProductBundleHandle implements MountedHomeAgentProductBundle {
  private disposeTask: Promise<void> | undefined;

  constructor(
    readonly context: Context,
    private readonly fiber: Fiber,
    private readonly runtime: HomeAgentProductBundleRuntime,
  ) {}

  get status(): HomeAgentRuntimeStatus {
    return this.runtime.status;
  }

  async dispose(): Promise<void> {
    this.disposeTask ??= this.fiber.dispose();
    return this.disposeTask;
  }
}

/**
 * Mounts the full Home Agent product into one Cordis child fiber.
 * The returned disposer unloads only that fiber and the resources it owns.
 */
export async function mountHomeAgentProductBundle(
  context: Context,
  options: HomeAgentRuntimeOptions,
): Promise<MountedHomeAgentProductBundle> {
  let runtime: HomeAgentProductBundleRuntime | undefined;
  const fiber = await context.plugin(async (bundleContext: Context) => {
    runtime = new HomeAgentProductBundleRuntime(bundleContext, options);
    await runtime.start();
    return () => runtime?.stop(false);
  });
  if (runtime === undefined) throw new Error("Home Agent product bundle did not start");
  const productContext = context.extend({ fiber });
  return new MountedHomeAgentProductBundleHandle(productContext, fiber, runtime);
}

/** Owns a private Cordis root while preserving the legacy runtime API. */
export class HomeAgentRuntime {
  readonly context: Context;
  private readonly bundle: HomeAgentProductBundleRuntime;

  constructor(options: HomeAgentRuntimeOptions) {
    this.context = new Context();
    this.bundle = new HomeAgentProductBundleRuntime(this.context, options);
  }

  get status(): HomeAgentRuntimeStatus {
    return this.bundle.status;
  }

  async start(): Promise<void> {
    await this.bundle.start(true);
  }

  async stop(): Promise<void> {
    await this.bundle.stop(true);
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
