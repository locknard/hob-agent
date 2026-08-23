import type { AuthProfile, WritableSecretVault } from "@hob-agent/agent-layer/model-credentials";
import { validateCustomModelBaseURL, type SupportedModelProvider } from "@hob-agent/agent-layer/model-providers";

import {
  ProductBootstrapConfigurationConflictError,
  type ProductBootstrapConfigStore,
} from "./product-bootstrap-config-store.js";
import type { ProductModelCleanupLedger } from "./product-model-cleanup-ledger.js";
import type { ProductModelSetup, ProductModelSetupStage } from "./product-model-setup.js";

/** The hub's intentionally narrow seam to the active model-provider resolver. */
export interface ProductOperationalModelResolver<Prepared = unknown> {
  status(): { readonly state: "ready" | "degraded" };
  prepare(candidate: ProductOperationalModelCandidate, signal?: AbortSignal): Promise<Prepared>;
  /** This swap is synchronous and returns its old-generation drain receipt. */
  activate(prepared: Prepared): { readonly drained: Promise<void> };
  discard(prepared: Prepared): Promise<void>;
}

export interface ProductOperationalModelCandidate {
  readonly provider: SupportedModelProvider;
  readonly model: string;
  readonly baseURL?: string;
  readonly profile: AuthProfile;
  readonly vault: WritableSecretVault;
}

export interface ProductOperationalModelSettingsOptions<Prepared = unknown> {
  readonly configurationStore: Pick<ProductBootstrapConfigStore, "load" | "commitModel">;
  readonly resolver: ProductOperationalModelResolver<Prepared>;
  readonly modelSetup: Pick<ProductModelSetup, "prepare" | "stageOperational" | "execute" | "discard">;
  readonly cleanupLedger: ProductModelCleanupLedger;
  readonly vault: WritableSecretVault;
  readonly createCandidateId: () => string;
}

export type ProductOperationalModelState = "active" | "degraded" | "retrying" | "switching";
export type ProductOperationalModelConfigureResult =
  | { readonly status: "configured"; readonly generation: number }
  | { readonly status: "cancelled" | "busy" | "conflict" | "unavailable" }
  | { readonly status: "probe_failed"; readonly reason: "missing_api_key" | "missing_model_id" | "missing_base_url" | "rejected" | "timed_out" | "unavailable" };

export interface ProductOperationalModelProjection {
  readonly status: ProductOperationalModelState;
  readonly generation: number;
  readonly configured: true;
  readonly modelReference: string;
  readonly modelBaseURL?: string;
  readonly credentialConfigured: boolean;
}

export class ProductOperationalModelSettings<Prepared = unknown> {
  private closed = false;
  private mutationInFlight = false;
  private state: ProductOperationalModelState;
  private mutationAbort: AbortController | undefined;
  private mutationTask: Promise<unknown> | undefined;
  private readonly maintenance = new Set<Promise<void>>();

  constructor(private readonly options: ProductOperationalModelSettingsOptions<Prepared>) {
    this.state = options.resolver.status().state === "ready" ? "active" : "degraded";
  }

  async projection(): Promise<ProductOperationalModelProjection> {
    const configuration = await this.options.configurationStore.load();
    if (configuration === undefined) throw new Error("Operational product configuration is unavailable");
    if (this.state !== "retrying" && this.state !== "switching") this.settleState();
    return Object.freeze({
      status: this.state,
      generation: configuration.generation,
      configured: true,
      modelReference: configuration.modelReference,
      ...(configuration.modelBaseURL === undefined ? {} : { modelBaseURL: configuration.modelBaseURL }),
      credentialConfigured: configuration.modelProfile.secretRef !== undefined,
    });
  }

  configure(input: {
    readonly expectedGeneration: number;
    readonly provider: SupportedModelProvider;
    readonly modelId: string;
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProductOperationalModelConfigureResult> {
    if (this.closed || isCancelled(input.signal)) return Promise.resolve({ status: "cancelled" });
    if (this.mutationInFlight) return Promise.resolve({ status: "busy" });
    return this.runMutation(input.signal, (signal) => this.configureCandidate({ ...input, signal }));
  }

  /** Re-mounts the configured exact profile without changing durable generation. */
  async retry(): Promise<ProductOperationalModelState> {
    if (this.closed || this.mutationInFlight) return this.settleState();
    this.state = "retrying";
    return this.runMutation(undefined, async (signal) => {
      try {
        const configuration = await this.options.configurationStore.load();
        if (configuration === undefined || signal.aborted) return this.settleState();
        const candidate = candidateForConfiguration(configuration, this.options.vault);
        const prepared = await this.options.resolver.prepare(candidate, signal);
        if (signal.aborted) {
          await this.options.resolver.discard(prepared).catch(() => undefined);
          return this.settleState();
        }
        const transition = this.options.resolver.activate(prepared);
        this.state = "active";
        // Retry mounts the same durable credential reference. The old runtime can
        // drain, but its credential remains active for the replacement generation.
        this.trackMaintenance(transition.drained);
        return this.state;
      } catch {
        return this.settleState();
      }
    });
  }

  cancelRetry(): void {
    if (this.state === "retrying") this.mutationAbort?.abort();
  }

  private async configureCandidate(input: {
    readonly expectedGeneration: number;
    readonly provider: SupportedModelProvider;
    readonly modelId: string;
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProductOperationalModelConfigureResult> {
    const current = await this.options.configurationStore.load();
    if (isCancelled(input.signal)) return { status: "cancelled" };
    if (current === undefined || current.generation !== input.expectedGeneration) return { status: "conflict" };
    this.state = "switching";
    try {
      await this.adoptCurrentModel(current);
    } catch {
      return this.failUnavailable();
    }
    const credential = await this.reuseCredentialIfAllowed(current, input);
    if (credential.status === "unavailable") return this.failUnavailable();
    const candidateId = this.options.createCandidateId();
    const preparation = this.options.modelSetup.prepare({ ...input, setupId: candidateId, apiKey: credential.apiKey });
    if (preparation.status !== "prepared") return this.probeFailure(preparation);
    if (isCancelled(input.signal)) return this.cancelled();
    let stage: ProductModelSetupStage;
    try { stage = this.options.modelSetup.stageOperational(preparation.prepared, candidateId); } catch { return this.failUnavailable(); }
    const reference = stage.profile.secretRef!;
    let credentialLease;
    try {
      credentialLease = await this.options.cleanupLedger.reserve({ candidateId, credentialRef: reference, expectedGeneration: input.expectedGeneration });
    } catch { return this.failUnavailable(); }
    if (isCancelled(input.signal)) return this.abandon(candidateId, stage, { status: "cancelled" });
    let probe: Awaited<ReturnType<ProductModelSetup["execute"]>>;
    try {
      probe = await this.options.modelSetup.execute({
        prepared: preparation.prepared,
        stage,
        credentialLease,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      return this.abandon(candidateId, stage, this.failUnavailable());
    }
    if (isCancelled(input.signal)) return this.abandon(candidateId, stage, { status: "cancelled" });
    if (probe.status !== "ready") return this.abandon(candidateId, stage, this.probeFailure(probe));
    let prepared: Prepared;
    try {
      prepared = await this.options.resolver.prepare(
        {
          provider: input.provider,
          model: probe.staged.modelId,
          ...(probe.staged.baseURL === undefined ? {} : { baseURL: probe.staged.baseURL }),
          profile: probe.staged.profile,
          vault: this.options.vault,
        },
        input.signal,
      );
    } catch {
      return this.abandon(
        candidateId,
        stage,
        isCancelled(input.signal) ? { status: "cancelled" } : this.failUnavailable(),
      );
    }
    if (isCancelled(input.signal)) {
      await this.options.resolver.discard(prepared).catch(() => undefined);
      return this.abandon(candidateId, stage, { status: "cancelled" });
    }
    let committed;
    try {
      committed = await this.options.configurationStore.commitModel(input.expectedGeneration, {
        modelReference: `${input.provider}/${probe.staged.modelId}`,
        ...(probe.staged.baseURL === undefined ? {} : { modelBaseURL: probe.staged.baseURL }),
        modelProfile: probe.staged.profile,
      });
    } catch (error) {
      await this.options.resolver.discard(prepared).catch(() => undefined);
      return this.abandon(candidateId, stage, error instanceof ProductBootstrapConfigurationConflictError ? { status: "conflict" } : this.failUnavailable());
    }
    try {
      await this.options.cleanupLedger.markCommitted({ candidateId, credentialRef: reference, expectedGeneration: input.expectedGeneration, committedGeneration: committed.generation });
    } catch {
      // The durable config is authoritative after CAS. Promote this exact staged
      // owner immediately; a restart repeats the same idempotent adoption.
      await this.options.cleanupLedger.adoptCommitted({ candidateId, credentialRef: reference, committedGeneration: committed.generation }).catch(() => undefined);
    }
    if (this.closed && isCancelled(input.signal)) {
      await this.options.resolver.discard(prepared).catch(() => undefined);
      return { status: "configured", generation: committed.generation };
    }
    // The resolver's structural contract makes activation a non-throwing, synchronous linearization after CAS.
    const transition = this.options.resolver.activate(prepared);
    this.state = "active";
    this.trackMaintenance(this.retireAfterDrain(current, transition.drained));
    return { status: "configured", generation: committed.generation };
  }

  private async reuseCredentialIfAllowed(
    current: Awaited<ReturnType<ProductBootstrapConfigStore["load"]>> extends infer T ? Exclude<T, undefined> : never,
    input: { readonly provider: SupportedModelProvider; readonly baseURL?: string; readonly apiKey: string },
  ): Promise<{ readonly status: "resolved"; readonly apiKey: string } | { readonly status: "unavailable" }> {
    if (input.apiKey !== "") return { status: "resolved", apiKey: input.apiKey };
    const provider = providerFromReference(current.modelReference);
    if (provider !== input.provider || !sameCanonicalEndpoint(current.modelBaseURL, input.provider, input.baseURL)) return { status: "resolved", apiKey: input.apiKey };
    const reference = current.modelProfile.secretRef;
    if (reference === undefined) return { status: "unavailable" };
    try {
      const apiKey = await this.options.vault.read(reference);
      if (apiKey === undefined || apiKey.trim().length === 0 || apiKey.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(apiKey)) return { status: "unavailable" };
      return { status: "resolved", apiKey };
    } catch { return { status: "unavailable" }; }
  }

  private async adoptCurrentModel(configuration: Exclude<Awaited<ReturnType<ProductBootstrapConfigStore["load"]>>, undefined>): Promise<void> {
    const parsed = managedModelOwner(configuration.modelProfile);
    if (parsed !== undefined) {
      await this.options.cleanupLedger.adoptCommitted({
        ...parsed,
        committedGeneration: configuration.generation,
      });
    }
  }

  private async abandon(candidateId: string, stage: ProductModelSetupStage, result: ProductOperationalModelConfigureResult): Promise<ProductOperationalModelConfigureResult> {
    const reference = stage.profile.secretRef!;
    try {
      await this.options.cleanupLedger.abandonStaged({ candidateId, credentialRef: reference });
      await this.options.cleanupLedger.markCleanupAttempt({ candidateId, credentialRef: reference });
      await this.options.vault.delete(reference);
      await this.options.cleanupLedger.acknowledge({ candidateId, credentialRef: reference });
    } catch { /* Durable pending_cleanup retains the exact locator for a later sweep. */ }
    this.state = this.options.resolver.status().state === "ready" ? "active" : "degraded";
    return result;
  }

  private async retireAfterDrain(configuration: Exclude<Awaited<ReturnType<ProductBootstrapConfigStore["load"]>>, undefined>, drained: Promise<void>): Promise<void> {
    await drained;
    const owner = managedModelOwner(configuration.modelProfile);
    if (owner !== undefined) {
      const exact = (await this.options.cleanupLedger.load()).entries.find((entry) =>
        entry.phase === "active"
        && entry.candidateId === owner.candidateId
        && entry.credentialRef === owner.credentialRef
      );
      if (exact !== undefined) {
        await this.options.cleanupLedger.retire({
          ...owner,
          committedGeneration: exact.committedGeneration!,
        });
      }
    }
    await this.sweepCleanup();
  }

  async sweepCleanup(): Promise<void> {
    const current = await this.options.configurationStore.load();
    const active = current?.modelProfile.secretRef;
    for (const entry of await this.options.cleanupLedger.listPending({ limit: 16 })) {
      if (entry.credentialRef === active) continue;
      try {
        await this.options.cleanupLedger.markCleanupAttempt(entry);
        await this.options.vault.delete(entry.credentialRef);
        await this.options.cleanupLedger.acknowledge(entry);
      } catch { /* The durable pending record authorizes a later bounded retry. */ }
    }
  }

  /** Closes request entry, aborts the active retry or configuration, then settles all owned retirement. */
  async closeAndDrain(): Promise<void> {
    this.closed = true;
    this.mutationAbort?.abort();
    while (this.mutationTask !== undefined) {
      await this.mutationTask.catch(() => undefined);
    }
    await this.drainMaintenance();
  }

  /** Waits until every already-owned credential retirement has settled. */
  async drainMaintenance(): Promise<void> {
    while (this.maintenance.size > 0) {
      await Promise.all(this.maintenance);
    }
  }

  private runMutation<T>(sourceSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const removeSourceAbort = followAbort(sourceSignal, controller);
    this.mutationInFlight = true;
    this.mutationAbort = controller;
    let task: Promise<T>;
    task = operation(controller.signal).finally(() => {
      removeSourceAbort();
      if (this.mutationAbort === controller) this.mutationAbort = undefined;
      this.mutationInFlight = false;
      if (this.mutationTask === task) this.mutationTask = undefined;
    });
    this.mutationTask = task;
    return task;
  }

  private probeFailure(outcome: Exclude<ReturnType<ProductModelSetup["prepare"]>, { readonly status: "prepared" }> | Exclude<Awaited<ReturnType<ProductModelSetup["execute"]>>, { readonly status: "ready" }>): ProductOperationalModelConfigureResult {
    if (outcome.status === "missing") return { status: "probe_failed", reason: outcome.field === "apiKey" ? "missing_api_key" : outcome.field === "modelId" ? "missing_model_id" : "missing_base_url" };
    if (outcome.status === "rejected") return { status: "probe_failed", reason: "rejected" };
    if (outcome.status === "timeout") return { status: "probe_failed", reason: "timed_out" };
    return { status: "probe_failed", reason: "unavailable" };
  }

  private failUnavailable(): ProductOperationalModelConfigureResult {
    this.state = this.options.resolver.status().state === "ready" ? "active" : "degraded";
    return { status: "unavailable" };
  }

  private cancelled(): ProductOperationalModelConfigureResult {
    this.state = this.options.resolver.status().state === "ready" ? "active" : "degraded";
    return { status: "cancelled" };
  }

  private settleState(): "active" | "degraded" {
    return this.state = this.options.resolver.status().state === "ready" ? "active" : "degraded";
  }

  private trackMaintenance(task: Promise<void>): void {
    const settled = task.catch(() => undefined).finally(() => this.maintenance.delete(settled));
    this.maintenance.add(settled);
  }
}

function providerFromReference(reference: string): SupportedModelProvider | undefined {
  const provider = reference.slice(0, reference.indexOf("/"));
  return provider === "gpt" || provider === "claude" || provider === "deepseek" || provider === "kimi" || provider === "glm" || provider === "custom" ? provider : undefined;
}
function sameCanonicalEndpoint(current: string | undefined, provider: SupportedModelProvider, next: string | undefined): boolean {
  if (provider !== "custom") return current === undefined && next === undefined;
  try {
    return current === validateCustomModelBaseURL(next ?? "");
  } catch {
    return false;
  }
}
function candidateForConfiguration(configuration: Exclude<Awaited<ReturnType<ProductBootstrapConfigStore["load"]>>, undefined>, vault: WritableSecretVault): ProductOperationalModelCandidate {
  const provider = providerFromReference(configuration.modelReference);
  if (provider === undefined) throw new Error("Configured model provider is invalid");
  return {
    provider,
    model: configuration.modelReference.slice(provider.length + 1),
    ...(configuration.modelBaseURL === undefined ? {} : { baseURL: configuration.modelBaseURL }),
    profile: configuration.modelProfile,
    vault,
  };
}
function managedModelOwner(profile: AuthProfile): { readonly candidateId: string; readonly credentialRef: string } | undefined {
  const reference = profile.secretRef;
  if (typeof reference !== "string") return undefined;
  const match = /^keychain:hob-agent\/(model|setup-model):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.exec(reference);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const profileKind = match[1] === "model" ? "operational" : "setup";
  if (profile.id !== `${profile.provider}:${profileKind}:${match[2]}`) return undefined;
  return { candidateId: match[2], credentialRef: reference };
}
function isCancelled(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function followAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => undefined;
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
