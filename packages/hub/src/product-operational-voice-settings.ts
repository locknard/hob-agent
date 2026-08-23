import type { WritableSecretVault } from "@hob-agent/agent-layer/model-credentials";

import {
  ProductBootstrapConfigurationConflictError,
  type ProductBootstrapConfiguration,
  type ProductBootstrapConfigStore,
  type ProductVoiceRuntimeConfig,
} from "./product-bootstrap-config-store.js";
import type { ProductVoiceCleanupLedger } from "./product-voice-cleanup-ledger.js";
import type {
  ProductVoiceProbeOutcome,
  ProductVoiceSetup,
  ProductVoiceSetupStage,
  ProductVoiceTrackInput,
} from "./product-voice-setup.js";
import type {
  PrivateVoiceGateway,
  PrivateVoiceGatewayRuntime,
  PrivateVoiceGatewayTransitionReceipt,
} from "./voice/private-voice-gateway.js";
import type { PrivateVoiceProviderRuntimeStatus } from "./voice/private-voice-provider-runtime.js";
import { normalizePrivateVoiceEndpoint } from "./voice/private-voice-endpoint.js";

interface ProductOperationalVoiceRuntime extends PrivateVoiceGatewayRuntime {
  start(): Promise<PrivateVoiceProviderRuntimeStatus>;
}

export interface ProductOperationalVoiceSettingsOptions {
  readonly configurationStore: Pick<ProductBootstrapConfigStore, "load" | "commitVoice">;
  readonly gateway: PrivateVoiceGateway;
  readonly voiceSetup: Pick<ProductVoiceSetup, "prepare" | "execute" | "discard">;
  readonly cleanupLedger: ProductVoiceCleanupLedger;
  readonly vault: WritableSecretVault;
  readonly createCandidateId: () => string;
  readonly createProviderRuntime: (config: ProductVoiceRuntimeConfig) => ProductOperationalVoiceRuntime;
}

export type ProductOperationalVoiceConfigureResult =
  | { readonly status: "configured"; readonly generation: number }
  | { readonly status: "cancelled" }
  | {
      readonly status: "probe_failed";
      readonly track: "asr" | "tts";
      readonly reason:
        | "missing_endpoint"
        | "missing_locale"
        | "credential_rejected"
        | "endpoint_unreachable"
        | "timed_out"
        | "incompatible"
        | "unavailable";
    }
  | { readonly status: "busy" | "conflict" | "unavailable" };

export type ProductOperationalVoiceDisableResult =
  | { readonly status: "disabled"; readonly generation: number }
  | { readonly status: "busy" | "conflict" | "unavailable" };

interface ProductOperationalVoiceProjectionBase {
  readonly generation: number;
}

export type ProductOperationalVoiceProjection =
  | (ProductOperationalVoiceProjectionBase & {
      readonly status: "disabled";
      readonly configured: false;
    })
  | (ProductOperationalVoiceProjectionBase & {
      readonly status: "active" | "degraded" | "retrying" | "switching";
      readonly configured: true;
      readonly asr: {
        readonly transport: "wyoming" | "openai_http";
        readonly endpoint: string;
        readonly model?: string;
        readonly credentialConfigured: boolean;
      };
      readonly tts: {
        readonly transport: "wyoming" | "openai_http";
        readonly endpoint: string;
        readonly model?: string;
        readonly locale: string;
        readonly voice?: string;
        readonly credentialConfigured: boolean;
      };
    });

export class ProductOperationalVoiceSettings {
  private mutationInFlight = false;
  private readonly maintenance = new Set<Promise<void>>();

  constructor(private readonly options: ProductOperationalVoiceSettingsOptions) {}

  async projection(): Promise<ProductOperationalVoiceProjection> {
    const configuration = await this.options.configurationStore.load();
    if (configuration === undefined) throw new Error("Operational product configuration is unavailable");
    const voice = configuration.voice;
    if (voice === undefined) {
      return Object.freeze({
        status: "disabled",
        generation: configuration.generation,
        configured: false,
      });
    }
    const gatewayStatus = this.options.gateway.status;
    return Object.freeze({
      status: gatewayStatus === "disabled" ? "degraded" : gatewayStatus,
      generation: configuration.generation,
      configured: true,
      asr: Object.freeze({
        transport: voice.asr.transport,
        endpoint: voice.asr.endpoint,
        ...(voice.asr.model === undefined ? {} : { model: voice.asr.model }),
        credentialConfigured: voice.asr.credentialRef !== undefined,
      }),
      tts: Object.freeze({
        transport: voice.tts.transport,
        endpoint: voice.tts.endpoint,
        ...(voice.tts.model === undefined ? {} : { model: voice.tts.model }),
        locale: voice.tts.locale,
        ...(voice.tts.voice === undefined ? {} : { voice: voice.tts.voice }),
        credentialConfigured: voice.tts.credentialRef !== undefined,
      }),
    });
  }

  retry(): Promise<ProductOperationalVoiceProjection["status"]> {
    return this.options.gateway.retry();
  }

  cancelRetry(): void {
    this.options.gateway.cancelRetry();
  }

  configure(input: {
    readonly expectedGeneration: number;
    /** The browser-owned background task may stop this candidate before durable configuration commits. */
    readonly signal?: AbortSignal;
    readonly asr: Extract<ProductVoiceTrackInput, { readonly kind: "asr" }>;
    readonly tts: Extract<ProductVoiceTrackInput, { readonly kind: "tts" }>;
  }): Promise<ProductOperationalVoiceConfigureResult> {
    if (isCancelled(input.signal)) return Promise.resolve({ status: "cancelled" });
    if (this.mutationInFlight) return Promise.resolve({ status: "busy" });
    this.mutationInFlight = true;
    return this.configureCandidate(input).finally(() => { this.mutationInFlight = false; });
  }

  private async configureCandidate(input: {
    readonly expectedGeneration: number;
    readonly signal?: AbortSignal;
    readonly asr: Extract<ProductVoiceTrackInput, { readonly kind: "asr" }>;
    readonly tts: Extract<ProductVoiceTrackInput, { readonly kind: "tts" }>;
  }): Promise<ProductOperationalVoiceConfigureResult> {
    const current = await this.options.configurationStore.load();
    if (isCancelled(input.signal)) return { status: "cancelled" };
    if (current === undefined || current.generation !== input.expectedGeneration) return { status: "conflict" };
    await this.adoptCurrentVoice(current);
    if (isCancelled(input.signal)) return { status: "cancelled" };
    const asr = await this.resolveCandidateTrack(current, input.asr);
    if (isCancelled(input.signal)) return { status: "cancelled" };
    const tts = await this.resolveCandidateTrack(current, input.tts);
    if (isCancelled(input.signal)) return { status: "cancelled" };
    if (asr.status !== "resolved" || tts.status !== "resolved") return { status: "unavailable" };
    const candidateId = this.options.createCandidateId();
    const stages: ProductVoiceSetupStage[] = [];
    const credentialStages: ProductVoiceSetupStage[] = [];

    for (const track of [asr.track, tts.track] as const) {
      if (isCancelled(input.signal)) {
        await this.abandonCandidate(candidateId, credentialStages);
        return { status: "cancelled" };
      }
      const preparation = this.options.voiceSetup.prepare({ setupId: candidateId, track });
      if (preparation.status !== "prepared") {
        await this.abandonCandidate(candidateId, credentialStages);
        return probeFailure(track.kind, preparation);
      }
      const stage = preparation.prepared.stage;
      if (stage.credentialRef !== undefined) {
        try {
          await this.options.cleanupLedger.reserve({
            candidateId,
            track: stage.kind,
            credentialRef: stage.credentialRef,
            expectedGeneration: input.expectedGeneration,
          });
          if (isCancelled(input.signal)) {
            await this.abandonCandidate(candidateId, credentialStages);
            return { status: "cancelled" };
          }
        } catch {
          await this.abandonCandidate(candidateId, credentialStages);
          return { status: "unavailable" };
        }
        credentialStages.push(stage);
      }
      const outcome = await this.options.voiceSetup.execute({
        prepared: preparation.prepared,
        ...(stage.credentialRef === undefined ? {} : { credentialLease: { stage } }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (isCancelled(input.signal)) {
        await this.abandonCandidate(candidateId, credentialStages);
        return { status: "cancelled" };
      }
      if (outcome.status !== "ready") {
        await this.abandonCandidate(candidateId, credentialStages);
        return probeFailure(track.kind, outcome);
      }
      stages.push(outcome.staged);
    }

    const voice = runtimeConfig(stages);
    let runtime: ProductOperationalVoiceRuntime | undefined;
    try {
      runtime = this.options.createProviderRuntime(voice);
      const started = await startCandidateRuntime(runtime, input.signal);
      if (isCancelled(input.signal)) {
        await runtime.dispose().catch(() => undefined);
        await this.abandonCandidate(candidateId, credentialStages);
        return { status: "cancelled" };
      }
      if (started.status !== "active") throw new Error("Private voice candidate is unavailable");
    } catch {
      await runtime?.dispose().catch(() => undefined);
      await this.abandonCandidate(candidateId, credentialStages);
      return isCancelled(input.signal) ? { status: "cancelled" } : { status: "unavailable" };
    }
    if (isCancelled(input.signal)) {
      try { runtime.cancel(); } catch { /* Runtime disposal completes the candidate cleanup path. */ }
      await runtime.dispose().catch(() => undefined);
      await this.abandonCandidate(candidateId, credentialStages);
      return { status: "cancelled" };
    }
    let committed: ProductBootstrapConfiguration;
    try {
      // commitVoice is the single durable linearization point. A cancellation
      // observed before this call owns cleanup; once the write begins the
      // committed generation owns its candidate and reports completion.
      committed = await this.options.configurationStore.commitVoice(input.expectedGeneration, voice);
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      await this.abandonCandidate(candidateId, credentialStages);
      return error instanceof ProductBootstrapConfigurationConflictError
        ? { status: "conflict" }
        : { status: "unavailable" };
    }
    for (const stage of stages) {
      if (stage.credentialRef === undefined) continue;
      try {
        await this.options.cleanupLedger.markCommitted({
          candidateId,
          track: stage.kind,
          credentialRef: stage.credentialRef,
          expectedGeneration: input.expectedGeneration,
          committedGeneration: committed.generation,
        });
      } catch {
        // Durable config is authoritative; cold-start reconciliation promotes this exact staged ref.
      }
    }
    let transition: PrivateVoiceGatewayTransitionReceipt;
    try {
      transition = await this.options.gateway.activate({
        configGeneration: committed.generation,
        providerGeneration: candidateId,
        runtime,
      });
    } catch {
      await runtime.dispose().catch(() => undefined);
      return { status: "unavailable" };
    }
    this.trackMaintenance(this.retireAfterDrain(current, transition.drained));
    return { status: "configured", generation: committed.generation };
  }

  disable(input: { readonly expectedGeneration: number }): Promise<ProductOperationalVoiceDisableResult> {
    if (this.mutationInFlight) return Promise.resolve({ status: "busy" });
    this.mutationInFlight = true;
    return this.disableCurrent(input).finally(() => { this.mutationInFlight = false; });
  }

  private async disableCurrent(input: { readonly expectedGeneration: number }): Promise<ProductOperationalVoiceDisableResult> {
    const current = await this.options.configurationStore.load();
    if (current === undefined || current.generation !== input.expectedGeneration) return { status: "conflict" };
    await this.adoptCurrentVoice(current);
    if (current.voice === undefined) {
      await this.options.gateway.disable().catch(() => undefined);
      return { status: "disabled", generation: current.generation };
    }
    let committed: ProductBootstrapConfiguration;
    try {
      committed = await this.options.configurationStore.commitVoice(input.expectedGeneration, undefined);
    } catch (error) {
      return error instanceof ProductBootstrapConfigurationConflictError
        ? { status: "conflict" }
        : { status: "unavailable" };
    }
    try {
      const transition = await this.options.gateway.disable();
      this.trackMaintenance(this.retireAfterDrain(current, transition.drained));
    } catch {
      return { status: "unavailable" };
    }
    return { status: "disabled", generation: committed.generation };
  }

  private async abandonCandidate(candidateId: string, stages: readonly ProductVoiceSetupStage[]): Promise<void> {
    for (const stage of stages) {
      const credentialRef = stage.credentialRef;
      if (credentialRef === undefined) continue;
      try {
        await this.options.cleanupLedger.abandonStaged({ candidateId, track: stage.kind, credentialRef });
        await this.options.cleanupLedger.markCleanupAttempt({ candidateId, track: stage.kind, credentialRef });
        await this.options.vault.delete(credentialRef);
        await this.options.cleanupLedger.acknowledge({ candidateId, track: stage.kind, credentialRef });
      } catch {
        // The durable pending-cleanup entry remains available for the next bounded sweep.
      }
    }
  }

  private async adoptCurrentVoice(configuration: ProductBootstrapConfiguration): Promise<void> {
    for (const owner of voiceCredentialOwners(configuration)) {
      await this.options.cleanupLedger.adoptCommitted(owner).catch(() => undefined);
    }
  }

  /**
   * A blank OpenAI-compatible credential means "keep the saved credential".
   * The value is read only to stage a fresh candidate locator for this request;
   * the previous locator remains owned by its live generation until it drains.
   */
  private async resolveCandidateTrack(
    current: ProductBootstrapConfiguration,
    track: ProductVoiceTrackInput,
  ): Promise<{ readonly status: "resolved"; readonly track: ProductVoiceTrackInput } | { readonly status: "unavailable" }> {
    if (track.transport !== "openai_http" || hasExplicitCredential(track.credential)) {
      return { status: "resolved", track };
    }
    const currentTrack = current.voice === undefined
      ? undefined
      : track.kind === "asr" ? current.voice.asr : current.voice.tts;
    const credentialRef = currentTrack?.transport === "openai_http" ? currentTrack.credentialRef : undefined;
    if (credentialRef === undefined) return { status: "resolved", track };
    let requestedEndpoint: string;
    try {
      requestedEndpoint = normalizePrivateVoiceEndpoint("openai_http", track.endpoint);
    } catch {
      return { status: "resolved", track };
    }
    if (currentTrack?.endpoint !== requestedEndpoint) return { status: "resolved", track };
    let credential: string | undefined;
    try {
      credential = await this.options.vault.read(credentialRef);
    } catch {
      return { status: "unavailable" };
    }
    if (!validSavedCredential(credential)) return { status: "unavailable" };
    return {
      status: "resolved",
      track: Object.freeze({ ...track, credential }),
    };
  }

  private async retireAfterDrain(configuration: ProductBootstrapConfiguration, drained: Promise<void>): Promise<void> {
    await drained;
    for (const owner of voiceCredentialOwners(configuration)) {
      await this.options.cleanupLedger.retire(owner).catch(() => undefined);
    }
    await this.sweepCleanup();
  }

  async sweepCleanup(): Promise<void> {
    const current = await this.options.configurationStore.load();
    const activeRefs = new Set(voiceCredentialOwners(current).map((owner) => owner.credentialRef));
    for (const entry of await this.options.cleanupLedger.listPending({ limit: 16 })) {
      if (activeRefs.has(entry.credentialRef)) continue;
      try {
        await this.options.cleanupLedger.markCleanupAttempt(entry);
        await this.options.vault.delete(entry.credentialRef);
        await this.options.cleanupLedger.acknowledge(entry);
      } catch {
        // The exact pending record remains durable for the next bounded maintenance pass.
      }
    }
  }

  private trackMaintenance(task: Promise<void>): void {
    const settled = task.catch(() => undefined).finally(() => { this.maintenance.delete(settled); });
    this.maintenance.add(settled);
  }
}

function voiceCredentialOwners(configuration: ProductBootstrapConfiguration | undefined): ReadonlyArray<{
  readonly candidateId: string;
  readonly track: "asr" | "tts";
  readonly credentialRef: string;
  readonly committedGeneration: number;
}> {
  if (configuration?.voice === undefined) return [];
  const owners: Array<{
    readonly candidateId: string;
    readonly track: "asr" | "tts";
    readonly credentialRef: string;
    readonly committedGeneration: number;
  }> = [];
  for (const [track, credentialRef] of [
    ["asr", configuration.voice.asr.credentialRef],
    ["tts", configuration.voice.tts.credentialRef],
  ] as const) {
    if (credentialRef === undefined) continue;
    const match = /^keychain:hob-agent\/voice:(asr|tts):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.exec(credentialRef);
    if (match === null || match[1] !== track || match[2] === undefined) continue;
    owners.push({ candidateId: match[2], track, credentialRef, committedGeneration: configuration.generation });
  }
  return owners;
}

function probeFailure(
  track: "asr" | "tts",
  outcome: Exclude<ProductVoiceProbeOutcome, { readonly status: "ready" }>,
): Extract<ProductOperationalVoiceConfigureResult, { readonly status: "probe_failed" }> {
  if (outcome.status === "missing") {
    return { status: "probe_failed", track, reason: outcome.field === "endpoint" ? "missing_endpoint" : "missing_locale" };
  }
  return { status: "probe_failed", track, reason: outcome.status };
}

function hasExplicitCredential(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function validSavedCredential(value: string | undefined): value is string {
  return value !== undefined
    && value.trim().length > 0
    && value.length <= 16_384
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function startCandidateRuntime(
  runtime: ProductOperationalVoiceRuntime,
  signal: AbortSignal | undefined,
): Promise<PrivateVoiceProviderRuntimeStatus> {
  if (signal?.aborted === true) {
    try { runtime.cancel(); } catch { /* Runtime disposal completes the candidate cleanup path. */ }
    return runtime.status;
  }
  const cancel = () => {
    try { runtime.cancel(); } catch { /* Runtime disposal completes the candidate cleanup path. */ }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await runtime.start();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function runtimeConfig(stages: readonly ProductVoiceSetupStage[]): ProductVoiceRuntimeConfig {
  const asr = stages.find((stage): stage is Extract<ProductVoiceSetupStage, { readonly kind: "asr" }> => stage.kind === "asr");
  const tts = stages.find((stage): stage is Extract<ProductVoiceSetupStage, { readonly kind: "tts" }> => stage.kind === "tts");
  if (asr === undefined || tts === undefined) throw new Error("Private voice requires verified input and output services");
  const { kind: _asrKind, ...asrConfig } = asr;
  const { kind: _ttsKind, ...ttsConfig } = tts;
  return Object.freeze({ asr: Object.freeze(asrConfig), tts: Object.freeze(ttsConfig) });
}
