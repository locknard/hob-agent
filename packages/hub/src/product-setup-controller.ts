import type {
  ProductSetupDraftPort,
  ProductSetupModelProbeResult,
} from "@hob-agent/inbox-web/setup";
import type { SupportedModelProvider } from "@hob-agent/agent-layer/model-providers";

import {
  ProductModelSetup,
  type ProductModelProbeOutcome,
  type ProductModelPrepareOutcome,
  type ProductModelPreparedProbe,
  type ProductModelSetupInput,
  type ProductModelSetupStage,
} from "./product-model-setup.js";
import {
  ProductSetupDraftStore,
  type ProductSetupBridgeCredentialLease,
  type ProductSetupModelCredentialLease,
  type ProductSetupVoiceCredentialLease,
} from "./product-setup-draft-store.js";
import {
  ProductBridgeSetup,
  type ProductBridgeProbeOutcome,
  type ProductBridgePrepareOutcome,
  type ProductBridgePreparedProbe,
  type ProductBridgeSetupStage,
} from "./product-bridge-setup.js";
import {
  ProductVoiceSetup,
  type ProductVoicePrepareOutcome,
  type ProductVoiceProbeOutcome,
  type ProductVoicePreparedProbe,
  type ProductVoiceSetupStage,
  type ProductVoiceTrackInput,
} from "./product-voice-setup.js";

const MODEL_PROVIDERS = new Set<SupportedModelProvider>(["gpt", "claude", "deepseek", "kimi", "glm", "custom"]);
const MAX_VOICE_CLEANUP_ATTEMPTS_PER_REQUEST = 4;
const MAX_MODEL_CLEANUP_ATTEMPTS_PER_REQUEST = 4;
const MAX_BRIDGE_CLEANUP_ATTEMPTS_PER_REQUEST = 4;

interface ModelSetupPort {
  prepare(input: ProductModelSetupInput): ProductModelPrepareOutcome;
  stageSetup(prepared: ProductModelPreparedProbe, setupId: string): ProductModelSetupStage;
  execute(input: {
    readonly prepared: ProductModelPreparedProbe;
    readonly stage: ProductModelSetupStage;
    readonly credentialLease: ProductSetupModelCredentialLease;
    readonly signal?: AbortSignal;
  }): Promise<ProductModelProbeOutcome>;
  discard(stage: ProductModelSetupStage): Promise<void>;
}

interface BridgeSetupPort {
  prepare(input: {
    readonly setupId: string;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }): ProductBridgePrepareOutcome;
  stageSetup(prepared: ProductBridgePreparedProbe, setupId: string): ProductBridgeSetupStage;
  execute(input: {
    readonly prepared: ProductBridgePreparedProbe;
    readonly stage: ProductBridgeSetupStage;
    readonly credentialLease: ProductSetupBridgeCredentialLease;
    readonly signal?: AbortSignal;
  }): Promise<ProductBridgeProbeOutcome>;
  discard(stage: ProductBridgeSetupStage): Promise<void>;
}

/** Tests one private voice capability without exposing provider credentials to setup state. */
interface VoiceSetupPort {
  prepare(input: {
    readonly setupId: string;
    readonly track: ProductVoiceTrackInput;
  }): ProductVoicePrepareOutcome;
  execute(input: {
    readonly prepared: ProductVoicePreparedProbe;
    readonly credentialLease?: ProductSetupVoiceCredentialLease;
    readonly signal?: AbortSignal;
  }): Promise<ProductVoiceProbeOutcome>;
  discard(stage: ProductVoiceSetupStage): Promise<void>;
}

/** Owns setup transactions that span the draft and request-local credentials. */
export class ProductSetupController implements ProductSetupDraftPort {
  private modelMutation: Promise<void> = Promise.resolve();
  private bridgeMutation: Promise<void> = Promise.resolve();
  private voiceMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly drafts: ProductSetupDraftStore,
    private readonly models: ModelSetupPort = new ProductModelSetup(),
    private readonly bridges: BridgeSetupPort = new ProductBridgeSetup(),
    private readonly voice: VoiceSetupPort = new ProductVoiceSetup(),
  ) {}

  async establishSession(input: { readonly sessionToken: string; readonly sessionExpiresAt: Date }) {
    const draft = await this.drafts.establishSession(input);
    await this.retryPendingModelCleanup();
    await this.retryPendingBridgeCleanup();
    await this.retryPendingVoiceCleanup();
    return draft;
  }

  async loadForSession(sessionToken: string) {
    const draft = await this.drafts.loadForSession(sessionToken);
    await this.retryPendingModelCleanup();
    await this.retryPendingBridgeCleanup();
    await this.retryPendingVoiceCleanup();
    return draft;
  }

  activationCandidateForSession(sessionToken: string, expectedRevision: number) {
    return this.drafts.activationCandidateForSession(sessionToken, expectedRevision);
  }

  async saveIdentity(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly householdName: string;
    readonly agentName: string;
  }) {
    const draft = await this.drafts.saveIdentity(input);
    await this.retryPendingModelCleanup();
    await this.retryPendingBridgeCleanup();
    await this.retryPendingVoiceCleanup();
    return draft;
  }

  async probeModel(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
    readonly apiKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ProductSetupModelProbeResult> {
    return this.exclusiveModel(async () => {
      try {
        const current = await this.drafts.loadForSession(input.sessionToken);
        if (current === undefined || current.stage !== "model" || current.revision !== input.expectedRevision) {
          return { status: "conflict" };
        }
        if (!isModelProvider(input.provider)) return { status: "rejected" };
        const preparation = this.models.prepare({
          setupId: current.draftId,
          provider: input.provider,
          modelId: input.modelId,
          apiKey: input.apiKey,
          ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
        });
        if (preparation.status !== "prepared") return preparation;
        let stage: ProductModelSetupStage;
        try {
          stage = this.models.stageSetup(preparation.prepared, current.draftId);
        } catch {
          return { status: "conflict" };
        }
        let credentialLease: ProductSetupModelCredentialLease;
        try {
          credentialLease = await this.drafts.reserveModelCredential({
            sessionToken: input.sessionToken,
            expectedRevision: input.expectedRevision,
            stage,
          });
        } catch {
          return { status: "conflict" };
        }
        let probed: ProductModelProbeOutcome;
        try {
          probed = await this.models.execute({
            prepared: preparation.prepared,
            stage,
            credentialLease,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        } catch {
          await this.discardStagedModelCredential(stage);
          return { status: "unavailable" };
        }
        if (isCancelled(input.signal)) {
          await this.discardStagedModelCredential(stage);
          return { status: "unavailable" };
        }
        if (probed.status !== "ready") {
          await this.discardStagedModelCredential(stage);
          return probed;
        }
        try {
          const draft = await this.drafts.recordModelProbe({
            sessionToken: input.sessionToken,
            expectedRevision: input.expectedRevision,
            stage: probed.staged,
            latencyMs: probed.latencyMs,
          });
          return { status: "ready", draft };
        } catch {
          await this.discardStagedModelCredential(stage);
          return { status: "conflict" };
        }
      } finally {
        await this.retryPendingModelCleanup();
        await this.retryPendingVoiceCleanup();
      }
    });
  }

  async probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
    readonly signal?: AbortSignal;
  }) {
    return this.exclusiveBridge(async () => {
      try {
      const current = await this.drafts.loadForSession(input.sessionToken);
      if (current === undefined || current.stage !== "bridge" || current.revision !== input.expectedRevision) {
        return { status: "conflict" as const };
      }
      const preparation = this.bridges.prepare({
        setupId: current.draftId,
        adapterType: input.adapterType,
        config: input.config,
        credential: input.credential,
      });
      if (preparation.status !== "prepared") return preparation;
      let stage: ProductBridgeSetupStage;
      let credentialLease: ProductSetupBridgeCredentialLease;
      try {
        stage = this.bridges.stageSetup(preparation.prepared, current.draftId);
        credentialLease = await this.drafts.reserveBridgeCredential({
          sessionToken: input.sessionToken,
          expectedRevision: input.expectedRevision,
          stage,
        });
      } catch {
        return { status: "conflict" as const };
      }
      let probed: ProductBridgeProbeOutcome;
      try {
        probed = await this.bridges.execute({
          prepared: preparation.prepared,
          stage,
          credentialLease,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        await this.discardStagedBridgeCredential(stage);
        return { status: "endpoint_unreachable" as const };
      }
      if (probed.status !== "ready") {
        await this.discardStagedBridgeCredential(stage);
        return probed;
      }
      if (isCancelled(input.signal)) {
        await this.discardStagedBridgeCredential(stage);
        return { status: "endpoint_unreachable" as const };
      }
      try {
        const draft = await this.drafts.recordBridgeProbe({
          sessionToken: input.sessionToken,
          expectedRevision: input.expectedRevision,
          stage: probed.stage,
          latencyMs: probed.latencyMs,
          summary: probed.summary,
          ...(probed.review === undefined ? {} : { review: probed.review }),
        });
        return { status: "ready" as const, draft };
      } catch {
        await this.discardStagedBridgeCredential(stage);
        return { status: "conflict" as const };
      }
      } finally {
        await this.retryPendingBridgeCleanup();
      await this.retryPendingVoiceCleanup();
      }
    });
  }

  async probeVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly track: ProductVoiceTrackInput;
    readonly signal?: AbortSignal;
  }) {
    return this.exclusiveVoice(async () => {
      try {
        const current = await this.drafts.loadForSession(input.sessionToken);
        if (current === undefined || current.stage !== "voice" || current.revision !== input.expectedRevision) {
          return { status: "conflict" as const };
        }
        const preparation = this.voice.prepare({ setupId: current.draftId, track: input.track });
        if (preparation.status !== "prepared") return preparation;
        let credentialLease: ProductSetupVoiceCredentialLease | undefined;
        if (preparation.prepared.stage.credentialRef !== undefined) {
          try {
            credentialLease = await this.drafts.reserveVoiceCredential({
              sessionToken: input.sessionToken,
              expectedRevision: input.expectedRevision,
              stage: preparation.prepared.stage,
            });
          } catch {
            return { status: "conflict" as const };
          }
        }
        const probed = await this.voice.execute({
          prepared: preparation.prepared,
          ...(credentialLease === undefined ? {} : { credentialLease }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (isCancelled(input.signal)) {
          await this.discardStagedVoiceCredential(preparation.prepared.stage);
          return { status: "unavailable" as const };
        }
        if (probed.status !== "ready") {
          await this.discardStagedVoiceCredential(preparation.prepared.stage);
          return probed;
        }
        try {
          const recorded = await this.drafts.recordVoiceProbe({
            sessionToken: input.sessionToken,
            expectedRevision: input.expectedRevision,
            stage: probed.staged,
            latencyMs: probed.latencyMs,
          });
          return { status: "ready" as const, draft: recorded.draft };
        } catch {
          await this.discardStagedVoiceCredential(preparation.prepared.stage);
          return { status: "conflict" as const };
        }
      } finally {
        await this.retryPendingVoiceCleanup();
      }
    });
  }

  async skipVoice(input: { readonly sessionToken: string; readonly expectedRevision: number }) {
    return this.exclusiveVoice(async () => {
      try {
        return (await this.drafts.skipVoice(input)).draft;
      } finally {
        await this.retryPendingVoiceCleanup();
      }
    });
  }

  /** Performs one bounded, session-independent cleanup pass for retired setup credentials. */
  async sweepVoiceCredentialCleanup(): Promise<void> {
    const pending = await this.drafts.pendingVoiceCleanupForMaintenance();
    for (const stage of pending.slice(0, MAX_VOICE_CLEANUP_ATTEMPTS_PER_REQUEST)) {
      try {
        await this.voice.discard(stage);
        await this.drafts.ackVoiceCleanupForMaintenance(stage);
      } catch {
        // The durable ledger retains this exact locator for a later bounded pass.
      }
    }
  }

  /** Performs one bounded pass over retired setup model credentials only. */
  async sweepModelCredentialCleanup(): Promise<void> {
    const pending = await this.drafts.pendingModelCleanupForMaintenance();
    for (const stage of pending.slice(0, MAX_MODEL_CLEANUP_ATTEMPTS_PER_REQUEST)) {
      try {
        await this.models.discard(stage);
        await this.drafts.ackModelCleanupForMaintenance(stage);
      } catch {
        // The durable cleanup record retains this exact locator for a later pass.
      }
    }
  }

  /** Performs one bounded pass over retired setup bridge credentials only. */
  async sweepBridgeCredentialCleanup(): Promise<void> {
    const pending = await this.drafts.pendingBridgeCleanupForMaintenance();
    for (const stage of pending.slice(0, MAX_BRIDGE_CLEANUP_ATTEMPTS_PER_REQUEST)) {
      try {
        await this.bridges.discard(stage);
        await this.drafts.ackBridgeCleanupForMaintenance(stage);
      } catch {
        // The durable cleanup record retains this exact locator for a later pass.
      }
    }
  }

  /** Recovers credential leases left by a process that stopped before it recorded voice evidence. */
  async recoverVoiceCredentialStaging(): Promise<void> {
    await this.drafts.retireVoiceStagingForRecovery();
  }

  /** Moves interrupted model writes to cleanup before ordinary maintenance can delete them. */
  async recoverModelCredentialStaging(): Promise<void> {
    await this.drafts.retireModelStagingForRecovery();
  }

  /** Moves interrupted bridge writes to cleanup before ordinary maintenance can delete them. */
  async recoverBridgeCredentialStaging(): Promise<void> {
    await this.drafts.retireBridgeStagingForRecovery();
  }

  private async retryPendingModelCleanup(): Promise<void> {
    try {
      await this.sweepModelCredentialCleanup();
    } catch {
      // Setup progress remains available while a maintenance dependency is unavailable.
    }
  }

  private async retryPendingBridgeCleanup(): Promise<void> {
    try {
      await this.sweepBridgeCredentialCleanup();
    } catch {
      // Setup progress remains available while a maintenance dependency is unavailable.
    }
  }

  private async retryPendingVoiceCleanup(): Promise<void> {
    try {
      await this.sweepVoiceCredentialCleanup();
    } catch {
      // Setup progress remains available while a maintenance dependency is unavailable.
    }
  }

  /** Serializes voice setup decisions so skip observes a completed probe revision. */
  private exclusiveVoice<T>(work: () => Promise<T>): Promise<T> {
    const result = this.voiceMutation.then(work, work);
    this.voiceMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Serializes probes for one setup draft so only one durable model lease can be live. */
  private exclusiveModel<T>(work: () => Promise<T>): Promise<T> {
    const result = this.modelMutation.then(work, work);
    this.modelMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Serializes bridge probes so one draft holds one exact bridge staging lease. */
  private exclusiveBridge<T>(work: () => Promise<T>): Promise<T> {
    const result = this.bridgeMutation.then(work, work);
    this.bridgeMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Deletes and acknowledges one exact model staging lease, or transfers it to durable cleanup. */
  private async discardStagedModelCredential(stage: ProductModelSetupStage): Promise<void> {
    try {
      await this.models.discard(stage);
      await this.drafts.ackModelStaging(stage);
    } catch {
      await this.drafts.retireModelStaging(stage).catch(() => undefined);
    }
  }

  /** Deletes and acknowledges one exact bridge staging lease, or transfers it to durable cleanup. */
  private async discardStagedBridgeCredential(stage: ProductBridgeSetupStage): Promise<void> {
    try {
      await this.bridges.discard(stage);
      await this.drafts.ackBridgeStaging(stage);
    } catch {
      await this.drafts.retireBridgeStaging(stage).catch(() => undefined);
    }
  }

  /** Removes and acknowledges one completed credential lease when the probe does not become active evidence. */
  private async discardStagedVoiceCredential(stage: ProductVoiceSetupStage): Promise<void> {
    if (stage.credentialRef === undefined) return;
    try {
      await this.voice.discard(stage);
      await this.drafts.ackVoiceStaging(stage);
    } catch {
      // The staging lease remains durable for the next cold-start recovery pass.
    }
  }
}

function isModelProvider(value: string): value is SupportedModelProvider {
  return MODEL_PROVIDERS.has(value as SupportedModelProvider);
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
