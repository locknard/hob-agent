import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import * as PiAiPlugin from "@deepseek-ai/dsh-llm-pi-ai";

import type { AuthProfile } from "../auth/profiles/auth-profiles.js";
import { EnvironmentSecretVault, type SecretVault } from "../auth/secrets/secret-vault.js";
import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";
import { providerSetup, type SupportedModelProvider } from "./model-providers.js";

/** The sole root route and model visible to the persistent Home Agent session. */
export const HOME_ACTIVE_PROVIDER_ROUTE = "hob-home-active";
export const HOME_ACTIVE_MODEL = "hob-home-active";

export interface ModelProviderCandidate {
  readonly provider: SupportedModelProvider;
  readonly model: string;
  readonly baseURL?: string;
  readonly profile?: AuthProfile;
  readonly vault?: SecretVault;
}

export interface ModelProviderGeneration {
  readonly provider: string;
  readonly model: string;
  readonly runtime: Pick<LlmRuntime, "stream" | "resolveModelInfo">;
  dispose(): Promise<void>;
}

export interface ModelProviderLease {
  release(): Promise<void>;
}

export interface ModelProviderResolverStatus {
  readonly state: "ready" | "degraded";
}

export interface ModelProviderResolverOptions {
  /** Test seam; production uses an isolated official DSH provider context. */
  readonly createGeneration?: (
    candidate: ModelProviderCandidate,
    signal?: AbortSignal,
  ) => Promise<ModelProviderGeneration>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    modelProviderResolver: ModelProviderResolver;
  }
}

interface HeldGeneration extends ModelProviderGeneration {
  readonly serial: number;
  leases: number;
  retired: boolean;
  disposed: boolean;
  readonly drained: Deferred<void>;
}

interface TurnLease {
  readonly lease?: ModelProviderLease;
  readonly generation?: HeldGeneration;
  readonly failure?: Error;
  signal?: AbortSignal;
  abortListener?: () => void;
  released: boolean;
}

interface AgentBinding {
  readonly agent: Agent;
  readonly turns: Map<number, TurnLease>;
  readonly disposeSessionListener: () => boolean;
  readonly disposePreStepListener: () => boolean;
  readonly disposeErrorListener: () => boolean;
}

const preparedToken = Symbol("prepared-model-provider-generation");

/** A mounted and structurally verified child generation awaiting a Hub commit. */
export class PreparedModelProviderGeneration {
  readonly #brand = true;
  #state: "prepared" | "consumed" | "discarded" = "prepared";

  constructor(
    private readonly generation: ModelProviderGeneration,
    private readonly owner: object,
    token: symbol,
  ) {
    if (token !== preparedToken) throw new Error("Prepared model provider generations come from a resolver");
  }

  take(owner: object): ModelProviderGeneration {
    this.assertOwner(owner);
    if (this.#state !== "prepared") throw new Error("Prepared model provider generation was already consumed or discarded");
    this.#state = "consumed";
    return this.generation;
  }

  discard(owner: object): ModelProviderGeneration {
    this.assertOwner(owner);
    if (this.#state !== "prepared") throw new Error("Prepared model provider generation was already consumed or discarded");
    this.#state = "discarded";
    return this.generation;
  }

  private assertOwner(owner: object): void {
    if (owner !== this.owner) throw new Error("Prepared model provider generation belongs to another resolver");
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

class ResolverClosedError extends Error {
  constructor() {
    super("Model provider resolver is disposed");
    this.name = "ResolverClosedError";
  }
}

class PreparationCancelledError extends Error {
  constructor() {
    super("Model provider preparation was cancelled");
    this.name = "PreparationCancelledError";
  }
}

/**
 * Selects exactly one provider generation for each Home Agent activity.
 * The persistent root loop sees only `HOME_ACTIVE_PROVIDER_ROUTE`.
 */
export class ModelProviderResolver extends Service {
  readonly adapter = new ResolverAdapter(this);

  private readonly createGeneration: (
    candidate: ModelProviderCandidate,
    signal?: AbortSignal,
  ) => Promise<ModelProviderGeneration>;
  private active: HeldGeneration | undefined;
  private readonly retired = new Set<HeldGeneration>();
  private readonly prepared = new Set<PreparedModelProviderGeneration>();
  private readonly pendingPreparations = new Set<Promise<PreparedModelProviderGeneration>>();
  private readonly preparationAborts = new Set<AbortController>();
  private readonly signalGenerations = new Map<AbortSignal, HeldGeneration>();
  private binding: AgentBinding | undefined;
  private serial = 0;
  private closed = false;
  private shutdown: Promise<void> | undefined;
  private readonly ownership = {};

  constructor(ctx: Context, options: ModelProviderResolverOptions = {}) {
    super(ctx, "modelProviderResolver");
    this.createGeneration = options.createGeneration ?? createDshProviderGeneration;
    this.ctx.effect(() => () => this.dispose(), "model-provider-resolver.dispose");
  }

  status(): ModelProviderResolverStatus {
    return { state: this.active === undefined ? "degraded" : "ready" };
  }

  prepare(
    candidate: ModelProviderCandidate,
    signal?: AbortSignal,
  ): Promise<PreparedModelProviderGeneration> {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(new PreparationCancelledError());
    const abort = new AbortController();
    const abortFromCaller = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    this.preparationAborts.add(abort);
    const pending = this.prepareCandidate(candidate, abort);
    this.pendingPreparations.add(pending);
    void pending.then(
      () => {
        this.pendingPreparations.delete(pending);
        this.preparationAborts.delete(abort);
        signal?.removeEventListener("abort", abortFromCaller);
      },
      () => {
        this.pendingPreparations.delete(pending);
        this.preparationAborts.delete(abort);
        signal?.removeEventListener("abort", abortFromCaller);
      },
    );
    return pending;
  }

  /** Commits one exact prepared generation with no asynchronous work. */
  activate(prepared: PreparedModelProviderGeneration): ModelProviderTransition {
    this.assertOpen();
    const created = prepared.take(this.ownership);
    this.prepared.delete(prepared);
    const next: HeldGeneration = {
      ...created,
      serial: ++this.serial,
      leases: 0,
      retired: false,
      disposed: false,
      drained: createDeferred<void>(),
    };
    const previous = this.active;
    this.active = next;
    if (previous !== undefined) {
      return new ModelProviderTransition(previous.serial, this.retire(previous));
    }
    return new ModelProviderTransition(undefined, Promise.resolve());
  }

  async discard(prepared: PreparedModelProviderGeneration): Promise<void> {
    const generation = prepared.discard(this.ownership);
    this.prepared.delete(prepared);
    await generation.dispose();
  }

  /** Convenience for isolated callers; production settings use prepare/CAS/activate. */
  async replace(candidate: ModelProviderCandidate): Promise<ModelProviderTransition> {
    const prepared = await this.prepare(candidate);
    return this.activate(prepared);
  }

  retry(candidate: ModelProviderCandidate): Promise<ModelProviderTransition> {
    return this.replace(candidate);
  }

  async degrade(): Promise<ModelProviderTransition> {
    this.assertOpen();
    const previous = this.active;
    this.active = undefined;
    if (previous !== undefined) {
      return new ModelProviderTransition(previous.serial, this.retire(previous));
    }
    return new ModelProviderTransition(undefined, Promise.resolve());
  }

  acquire(): ModelProviderLease {
    const generation = this.acquireGeneration();
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.releaseGeneration(generation);
      },
    };
  }

  /** Binds the sole persistent Home Agent to exact durable turn boundaries. */
  bindAgent(agent: Agent): void {
    this.assertOpen();
    if (this.binding !== undefined) {
      if (this.binding.agent === agent) return;
      throw new Error("Model provider resolver already owns a Home Agent binding");
    }
    const turns = new Map<number, TurnLease>();
    const binding: AgentBinding = {
      agent,
      turns,
      disposeSessionListener: this.ctx.on("session/event", (session, event) => {
        if (session !== agent.session) return;
        if (event.type === "turn/start") {
          this.beginTurn(binding, event.data.turn);
        } else if (event.type === "turn/end") {
          this.releaseTurn(binding, event.data.turn);
        }
      }, { global: true }),
      disposePreStepListener: agent.ctx.on("agent/pre-step", async ({ turn, signal }, next) => {
        const lease = binding.turns.get(turn);
        if (lease === undefined || lease.failure !== undefined || lease.generation === undefined || lease.released) {
          return { kind: "reject" };
        }
        if (lease.signal !== undefined && lease.signal !== signal) return { kind: "reject" };
        if (lease.signal === undefined) {
          lease.signal = signal;
          lease.abortListener = () => this.releaseTurn(binding, turn);
          this.signalGenerations.set(signal, lease.generation);
          signal.addEventListener("abort", lease.abortListener, { once: true });
        }
        return next();
      }, { prepend: true }),
      disposeErrorListener: agent.ctx.on("agent/error", ({ turn }) => {
        this.releaseTurn(binding, turn);
      }),
    };
    this.binding = binding;
    agent.ctx.effect(() => () => this.unbindAgent(binding), "model-provider-resolver.turn-ownership");
  }

  dispose(): Promise<void> {
    if (this.shutdown !== undefined) return this.shutdown;
    this.closed = true;
    for (const abort of this.preparationAborts) abort.abort();
    const active = this.active;
    this.active = undefined;
    if (active !== undefined) {
      this.retire(active);
    }
    this.shutdown = this.finishShutdown();
    return this.shutdown;
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const generation = this.generationFor(options.signal);
    if (generation === undefined) throw new Error("Model provider turn lease is unavailable");
    return generation.runtime.stream({
      ...options,
      provider: generation.provider,
      model: generation.model,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new ResolverClosedError();
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== HOME_ACTIVE_PROVIDER_ROUTE || model !== HOME_ACTIVE_MODEL) {
      throw new Error("Model provider resolver received an unknown virtual route");
    }
    const generation = this.generationFor(signal, { allowUnboundMetadata: true });
    if (generation === undefined) {
      return {
        provider: HOME_ACTIVE_PROVIDER_ROUTE,
        id: HOME_ACTIVE_MODEL,
        name: HOME_ACTIVE_MODEL,
      };
    }
    const resolved = await generation.runtime.resolveModelInfo(
      generation.provider,
      generation.model,
      signal,
    );
    return {
      ...resolved,
      provider: HOME_ACTIVE_PROVIDER_ROUTE,
      id: HOME_ACTIVE_MODEL,
      name: HOME_ACTIVE_MODEL,
    };
  }

  private async prepareCandidate(
    candidate: ModelProviderCandidate,
    abort: AbortController,
  ): Promise<PreparedModelProviderGeneration> {
    let generation: ModelProviderGeneration | undefined;
    let transferred = false;
    try {
      generation = await this.createGeneration(candidate, abort.signal);
      this.assertPreparationOpen(abort);
      await generation.runtime.resolveModelInfo(generation.provider, generation.model, abort.signal);
      this.assertPreparationOpen(abort);
      const prepared = new PreparedModelProviderGeneration(generation, this.ownership, preparedToken);
      this.prepared.add(prepared);
      transferred = true;
      return prepared;
    } catch (error) {
      if (generation !== undefined && !transferred) await generation.dispose();
      if (abort.signal.aborted) {
        if (this.closed) throw new ResolverClosedError();
        throw new PreparationCancelledError();
      }
      throw error;
    }
  }

  private assertPreparationOpen(abort: AbortController): void {
    if (this.closed || abort.signal.aborted) throw new ResolverClosedError();
  }

  private async finishShutdown(): Promise<void> {
    const pending = await Promise.allSettled([...this.pendingPreparations]);
    const discarded = await Promise.allSettled([...this.prepared].map(async (prepared) => {
      const generation = prepared.discard(this.ownership);
      this.prepared.delete(prepared);
      await generation.dispose();
    }));
    const drained = await Promise.allSettled([...this.retired].map((generation) => generation.drained.promise));
    const failures = [...pending, ...discarded, ...drained]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .filter((error) => !(error instanceof ResolverClosedError || error instanceof PreparationCancelledError));
    if (failures.length > 0) throw new AggregateError(failures, "Model provider resolver cleanup failed");
  }

  private acquireGeneration(): HeldGeneration {
    this.assertOpen();
    if (this.active === undefined) throw new Error("Model provider is degraded");
    const generation = this.active;
    generation.leases += 1;
    return generation;
  }

  private releaseGeneration(generation: HeldGeneration): void {
    if (generation.leases === 0) return;
    generation.leases -= 1;
    this.disposeIfUnused(generation);
  }

  private beginTurn(binding: AgentBinding, turn: number): void {
    if (binding.turns.has(turn)) return;
    try {
      const generation = this.acquireGeneration();
      const lease: ModelProviderLease = {
        release: async () => this.releaseGeneration(generation),
      };
      binding.turns.set(turn, { lease, generation, released: false });
    } catch (error) {
      binding.turns.set(turn, {
        failure: error instanceof Error ? error : new Error(String(error)),
        released: false,
      });
    }
  }

  private releaseTurn(binding: AgentBinding, turn: number): void {
    const lease = binding.turns.get(turn);
    if (lease === undefined || lease.released) return;
    lease.released = true;
    binding.turns.delete(turn);
    if (lease.signal !== undefined) {
      this.signalGenerations.delete(lease.signal);
      if (lease.abortListener !== undefined) lease.signal.removeEventListener("abort", lease.abortListener);
    }
    void lease.lease?.release();
  }

  private unbindAgent(binding: AgentBinding): void {
    if (this.binding !== binding) return;
    this.binding = undefined;
    binding.disposeSessionListener();
    binding.disposePreStepListener();
    binding.disposeErrorListener();
    for (const turn of [...binding.turns.keys()]) this.releaseTurn(binding, turn);
  }

  private generationFor(
    signal: AbortSignal | undefined,
    options: { readonly allowUnboundMetadata?: boolean } = {},
  ): HeldGeneration | undefined {
    if (signal !== undefined) {
      const generation = this.signalGenerations.get(signal);
      if (generation === undefined) throw new Error("Model provider turn lease is unavailable");
      return generation;
    }
    const leases = [...this.binding?.turns.values() ?? []]
      .filter((lease) => !lease.released && lease.generation !== undefined)
      .map((lease) => lease.generation!);
    if (leases.length === 1) return leases[0];
    if (leases.length === 0 && options.allowUnboundMetadata) return undefined;
    throw new Error("Model provider turn lease is unavailable");
  }

  private retire(generation: HeldGeneration): Promise<void> {
    if (generation.retired) return generation.drained.promise;
    generation.retired = true;
    this.retired.add(generation);
    this.disposeIfUnused(generation);
    return generation.drained.promise;
  }

  private disposeIfUnused(generation: HeldGeneration): void {
    if (!generation.retired || generation.leases !== 0 || generation.disposed) return;
    generation.disposed = true;
    void Promise.resolve().then(() => generation.dispose()).then(
      () => {
        this.retired.delete(generation);
        generation.drained.resolve();
      },
      (error: unknown) => {
        this.retired.delete(generation);
        generation.drained.reject(error);
      },
    );
  }
}

/** A branded transition whose drain promise is owned by one resolver swap. */
export class ModelProviderTransition {
  readonly #brand = true;

  constructor(
    readonly priorGeneration: number | undefined,
    readonly drained: Promise<void>,
  ) {}
}

class ResolverAdapter extends LlmAdapter {
  constructor(private readonly resolver: ModelProviderResolver) {
    super();
  }

  override async listModels() {
    return [{ provider: HOME_ACTIVE_PROVIDER_ROUTE, id: HOME_ACTIVE_MODEL, name: HOME_ACTIVE_MODEL }];
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolver.resolveModel(provider, model, signal);
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.resolver.stream(options);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // `drained` remains rejectable for its transition owner while this observer
  // prevents an owner that records it later from creating a process-global
  // unhandled-rejection race.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function createDshProviderGeneration(
  candidate: ModelProviderCandidate,
  signal?: AbortSignal,
): Promise<ModelProviderGeneration> {
  signal?.throwIfAborted();
  const setup = providerSetup(
    candidate.provider,
    candidate.baseURL === undefined ? undefined : { baseURL: candidate.baseURL },
  );
  if ((candidate.profile === undefined) !== (candidate.vault === undefined)) {
    throw new Error("Selected profile and SecretVault must be provided together");
  }
  if (candidate.profile !== undefined && candidate.vault !== undefined) {
    if (candidate.profile.provider !== candidate.provider || candidate.profile.kind !== "api_key") {
      throw new Error("Selected profile cannot authenticate this DSH provider route");
    }
    if (!candidate.profile.secretRef) throw new Error("Selected API-key profile is missing a secret reference");
  }

  const ctx = new Context();
  try {
    const credentialReference = candidate.profile?.secretRef ?? `env:${setup.credentialEnv}`;
    await ctx.plugin(DshProfileCredentialProvider, {
      references: { [setup.credentialEnv]: credentialReference },
      vault: candidate.vault ?? new EnvironmentSecretVault(process.env, [setup.credentialEnv]),
    });
    signal?.throwIfAborted();
    await ctx.plugin(LlmRuntime);
    signal?.throwIfAborted();
    await ctx.plugin(PiAiPlugin, {
      providers: {
        [setup.runtimeProviderId]: setup.baseURL === undefined
          ? { apiKeyEnv: setup.credentialEnv }
          : {
              displayName: "Custom OpenAI-compatible deployment",
              apiKeyEnv: setup.credentialEnv,
              api: "openai-completions",
              baseURL: setup.baseURL,
              models: [{ id: candidate.model, name: candidate.model }],
            },
      },
    });
    signal?.throwIfAborted();
    return {
      provider: setup.runtimeProviderId,
      model: candidate.model,
      runtime: ctx.llm,
      dispose: () => ctx.fiber.dispose(),
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
