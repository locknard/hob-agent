import type {
  ProductSetupDraftPort,
  ProductSetupDraftProjection,
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

const MODEL_PROVIDERS = new Set<SupportedModelProvider>(["gpt", "claude", "deepseek", "kimi", "glm", "custom"]);

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

/** Owns setup transactions that span the draft and request-local credentials. */
export class ProductSetupController implements ProductSetupDraftPort {
  constructor(
    private readonly drafts: ProductSetupDraftStore,
    private readonly models: ModelSetupPort = new ProductModelSetup(),
    private readonly bridges: BridgeSetupPort = new ProductBridgeSetup(),
  ) {}

  establishSession(input: { readonly sessionToken: string; readonly sessionExpiresAt: Date }) {
    return this.drafts.establishSession(input);
  }

  loadForSession(sessionToken: string) {
    return this.drafts.loadForSession(sessionToken);
  }

  activationCandidateForSession(sessionToken: string, expectedRevision: number) {
    return this.drafts.activationCandidateForSession(sessionToken, expectedRevision);
  }

  saveIdentity(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly householdName: string;
    readonly agentName: string;
  }) {
    return this.drafts.saveIdentity(input);
  }

  async probeModel(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly provider: string;
    readonly modelId: string;
    readonly baseURL?: string;
    readonly apiKey: string;
  }): Promise<ProductSetupModelProbeResult> {
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
  }

  async probeBridge(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly adapterType: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: string;
  }) {
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
  }
}

function isModelProvider(value: string): value is SupportedModelProvider {
  return MODEL_PROVIDERS.has(value as SupportedModelProvider);
}
