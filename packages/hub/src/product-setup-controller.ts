import type {
  ProductSetupDraftPort,
  ProductSetupModelProbeResult,
} from "@hob-agent/inbox-web/setup";
import type { SupportedModelProvider } from "@hob-agent/agent-layer/model-providers";

import {
  ProductModelSetup,
  type ProductModelProbeOutcome,
  type ProductModelSetupInput,
  type ProductModelSetupStage,
} from "./product-model-setup.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import {
  ProductBridgeSetup,
  type ProductBridgeProbeOutcome,
  type ProductBridgeSetupStage,
} from "./product-bridge-setup.js";
import {
  ProductVoiceSetup,
  type ProductVoiceCredentialLease,
  type ProductVoicePrepareOutcome,
  type ProductVoiceProbeOutcome,
  type ProductVoicePreparedProbe,
  type ProductVoiceSetupStage,
  type ProductVoiceTrackInput,
} from "./product-voice-setup.js";

const MODEL_PROVIDERS = new Set<SupportedModelProvider>(["gpt", "claude", "deepseek", "kimi", "glm", "custom"]);
const MAX_VOICE_CLEANUP_ATTEMPTS_PER_REQUEST = 4;

interface ModelSetupPort {
  probe(input: ProductModelSetupInput): Promise<ProductModelProbeOutcome>;
  discard(stage: ProductModelSetupStage): Promise<void>;
}

interface BridgeSetupPort {
  probe(input: {
    readonly setupId: string;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
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
    readonly credentialLease?: ProductVoiceCredentialLease;
  }): Promise<ProductVoiceProbeOutcome>;
  discard(stage: ProductVoiceSetupStage): Promise<void>;
}

/** Owns setup transactions that span the draft and request-local credentials. */
export class ProductSetupController implements ProductSetupDraftPort {
  private voiceMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly drafts: ProductSetupDraftStore,
    private readonly models: ModelSetupPort = new ProductModelSetup(),
    private readonly bridges: BridgeSetupPort = new ProductBridgeSetup(),
    private readonly voice: VoiceSetupPort = new ProductVoiceSetup(),
  ) {}

  async establishSession(input: { readonly sessionToken: string; readonly sessionExpiresAt: Date }) {
    const draft = await this.drafts.establishSession(input);
    await this.retryPendingVoiceCleanup();
    return draft;
  }

  async loadForSession(sessionToken: string) {
    const draft = await this.drafts.loadForSession(sessionToken);
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
  }): Promise<ProductSetupModelProbeResult> {
    try {
      const current = await this.drafts.loadForSession(input.sessionToken);
      if (current === undefined || current.stage !== "model" || current.revision !== input.expectedRevision) {
        return { status: "conflict" };
      }
      if (!isModelProvider(input.provider)) return { status: "rejected" };
      const probed = await this.models.probe({
        setupId: current.draftId,
        provider: input.provider,
        modelId: input.modelId,
        apiKey: input.apiKey,
        ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
      });
      if (probed.status !== "ready") return probed;
      try {
        const draft = await this.drafts.recordModelProbe({
          sessionToken: input.sessionToken,
          expectedRevision: input.expectedRevision,
          stage: probed.staged,
          latencyMs: probed.latencyMs,
        });
        return { status: "ready", draft };
      } catch {
        await this.models.discard(probed.staged);
        return { status: "conflict" };
      }
    } finally {
      await this.retryPendingVoiceCleanup();
    }
  }

  async probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }) {
    try {
      const current = await this.drafts.loadForSession(input.sessionToken);
      if (current === undefined || current.stage !== "bridge" || current.revision !== input.expectedRevision) {
        return { status: "conflict" as const };
      }
      const probed = await this.bridges.probe({
        setupId: current.draftId,
        adapterType: input.adapterType,
        config: input.config,
        credential: input.credential,
      });
      if (probed.status !== "ready") return probed;
      try {
        const draft = await this.drafts.recordBridgeProbe({
          sessionToken: input.sessionToken,
          expectedRevision: input.expectedRevision,
          stage: probed.stage,
          latencyMs: probed.latencyMs,
          summary: probed.summary,
        });
        return { status: "ready" as const, draft };
      } catch {
        await this.bridges.discard(probed.stage);
        return { status: "conflict" as const };
      }
    } finally {
      await this.retryPendingVoiceCleanup();
    }
  }

  async probeVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly track: ProductVoiceTrackInput;
  }) {
    return this.exclusiveVoice(async () => {
      try {
        const current = await this.drafts.loadForSession(input.sessionToken);
        if (current === undefined || current.stage !== "voice" || current.revision !== input.expectedRevision) {
          return { status: "conflict" as const };
        }
        const preparation = this.voice.prepare({ setupId: current.draftId, track: input.track });
        if (preparation.status !== "prepared") return preparation;
        let credentialLease: ProductVoiceCredentialLease | undefined;
        if (preparation.prepared.stage.credentialRef !== undefined) {
          try {
            await this.drafts.reserveVoiceCredential({
              sessionToken: input.sessionToken,
              expectedRevision: input.expectedRevision,
              stage: preparation.prepared.stage,
            });
            credentialLease = Object.freeze({ stage: preparation.prepared.stage });
          } catch {
            return { status: "conflict" as const };
          }
        }
        const probed = await this.voice.execute({ prepared: preparation.prepared, ...(credentialLease === undefined ? {} : { credentialLease }) });
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

  /** Recovers credential leases left by a process that stopped before it recorded voice evidence. */
  async recoverVoiceCredentialStaging(): Promise<void> {
    await this.drafts.retireVoiceStagingForRecovery();
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
