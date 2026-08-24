import type {
  PrivateVoiceProviderRuntimeStatus,
  PrivateVoiceSynthesisInput,
  PrivateVoiceSynthesisResult,
  PrivateVoiceTranscriptionInput,
  PrivateVoiceTranscriptionResult,
} from "./private-voice-provider-runtime.js";

export type PrivateVoiceGatewayStatus = "disabled" | "active" | "degraded" | "retrying" | "switching";
export type PrivateVoiceCaptureMode = "encoded_audio" | "pcm_s16le";
export type PrivateVoiceRecognitionMode = "final_only" | "partial";

/** The narrow runtime seam keeps provider construction outside the stable gateway. */
export interface PrivateVoiceGatewayRuntime {
  readonly status: PrivateVoiceProviderRuntimeStatus;
  readonly recognitionMode?: PrivateVoiceRecognitionMode;
  readonly captureMode: PrivateVoiceCaptureMode;
  transcribe(input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult>;
  synthesize(input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult>;
  retry(): Promise<PrivateVoiceProviderRuntimeStatus>;
  /** Cancels only the runtime readiness probe, never a leased ASR/TTS call. */
  cancelRetry?(): void;
  cancel(): void;
  dispose(): Promise<void>;
}

export interface PrivateVoiceGatewayCandidate {
  /** The durable configuration revision that selected this runtime. */
  readonly configGeneration: number;
  /** The unique runtime generation created from the verified candidate. */
  readonly providerGeneration: string;
  readonly runtime: PrivateVoiceGatewayRuntime;
}

export interface PrivateVoiceTurnLease {
  /** Gateway-local identifier. The HTTP surface owns its separate opaque browser capability. */
  readonly leaseId: string;
  readonly configGeneration: number;
  readonly providerGeneration: string;
  readonly recognitionMode: PrivateVoiceRecognitionMode;
  readonly captureMode: PrivateVoiceCaptureMode;
  transcribe(input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult>;
  synthesize(input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult>;
  release(): Promise<void>;
}

export interface PrivateVoiceGatewayTransitionReceipt {
  /** The draining generation whose exact references become eligible for cleanup. */
  readonly priorProviderGeneration?: string;
  /** Resolves after the prior generation drains and its runtime is disposed. */
  readonly drained: Promise<void>;
}

export interface PrivateVoiceGatewayOptions {
  /** The gateway attempts a degraded runtime this many times for one retry request. */
  readonly maxRetryAttempts?: number;
  /** Supplies a deterministic timer seam for bounded automatic recovery. */
  readonly scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
  /** Returns the delay before one automatic recovery attempt. Attempt numbering starts at one. */
  readonly retryDelayMs?: (attempt: number) => number;
}

export interface PrivateVoiceGatewayDisposeOptions {
  /** Forces disposal without waiting for leased turns. Tests and process shutdown use this explicit path. */
  readonly force?: boolean;
}

interface Generation extends PrivateVoiceGatewayCandidate {
  leases: number;
  draining: boolean;
  disposed: boolean;
  drain: Deferred<void> | undefined;
  disposeTask: Promise<void> | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface CombinedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface AutomaticRetryCycle {
  readonly generation: Generation;
  attempts: number;
  cancel: (() => void) | undefined;
}

/**
 * Keeps a stable voice boundary while provider generations are replaced or drained.
 * A lease owns the exact runtime it received for the full ASR and TTS turn.
 */
export class PrivateVoiceGateway {
  private current: Generation | undefined;
  private readonly generations = new Set<Generation>();
  private phase: "normal" | "retrying" | "switching" = "normal";
  private retryTask: Promise<PrivateVoiceGatewayStatus> | undefined;
  private retryGeneration: Generation | undefined;
  private retryCancelled = false;
  private cancelledRetryGeneration: Generation | undefined;
  private automaticRetry: AutomaticRetryCycle | undefined;
  private switchTask: Promise<PrivateVoiceGatewayTransitionReceipt> | undefined;
  private disposed = false;
  private disposeTask: Promise<void> | undefined;
  private nextTurn = 1;
  private readonly maxRetryAttempts: number;
  private readonly scheduleRetry: (callback: () => void, delayMs: number) => () => void;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(initial?: PrivateVoiceGatewayCandidate, options: PrivateVoiceGatewayOptions = {}) {
    this.maxRetryAttempts = boundedAttempts(options.maxRetryAttempts);
    this.scheduleRetry = options.scheduleRetry ?? scheduleRetry;
    this.retryDelayMs = options.retryDelayMs ?? exponentialRetryDelay;
    if (typeof this.scheduleRetry !== "function" || typeof this.retryDelayMs !== "function") {
      throw new TypeError("Private voice gateway retry scheduler is invalid");
    }
    if (initial !== undefined) {
      this.current = this.createGeneration(initial);
      this.scheduleAutomaticRetry(this.current);
    }
  }

  get status(): PrivateVoiceGatewayStatus {
    if (this.disposed || this.current === undefined) return "disabled";
    if (this.phase === "retrying") return "retrying";
    if (this.phase === "switching") return "switching";
    if (this.cancelledRetryGeneration === this.current) return "degraded";
    return this.current.runtime.status.status === "active" ? "active" : "degraded";
  }

  get recognitionMode(): PrivateVoiceRecognitionMode {
    return this.current?.runtime.recognitionMode ?? "final_only";
  }

  /** Issues a frozen turn lease only to the current active provider generation. */
  beginTurn(): PrivateVoiceTurnLease | undefined {
    const generation = this.current;
    if (this.disposed
      || this.phase === "retrying"
      || generation === undefined
      || this.cancelledRetryGeneration === generation
      || generation.runtime.status.status !== "active") return undefined;
    generation.leases += 1;
    const controller = new AbortController();
    const operations = new Set<Promise<unknown>>();
    let released = false;
    let releaseTask: Promise<void> | undefined;
    const transcribe = (input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult> => {
      if (released) return Promise.resolve(cancelledTranscription());
      return trackOperation(operations, this.observeLeaseOperation(generation, this.runLeaseOperation(
        controller.signal,
        input.signal,
        (signal) => generation.runtime.transcribe({ ...input, signal }),
        cancelledTranscription(),
        () => released,
      )));
    };
    const synthesize = (input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult> => {
      if (released) return Promise.resolve(cancelledSynthesis());
      return trackOperation(operations, this.observeLeaseOperation(generation, this.runLeaseOperation(
        controller.signal,
        input.signal,
        (signal) => generation.runtime.synthesize({ ...input, signal }),
        cancelledSynthesis(),
        () => released,
      )));
    };
    const lease: PrivateVoiceTurnLease = Object.freeze({
      leaseId: `lease-${this.nextTurn++}`,
      configGeneration: generation.configGeneration,
      providerGeneration: generation.providerGeneration,
      recognitionMode: generation.runtime.recognitionMode ?? "final_only",
      captureMode: generation.runtime.captureMode,
      transcribe,
      synthesize,
      release: () => {
        if (released) return releaseTask ?? Promise.resolve();
        released = true;
        controller.abort();
        releaseTask = Promise.allSettled([...operations]).then(() => {
          generation.leases -= 1;
          return generation.draining && generation.leases === 0
            ? this.disposeGeneration(generation)
            : undefined;
        });
        return releaseTask;
      },
    });
    return lease;
  }

  /**
   * Publishes an already-started candidate. Existing leases retain the old runtime
   * until they release, while later leases use the candidate generation.
   */
  activate(candidate: PrivateVoiceGatewayCandidate): Promise<PrivateVoiceGatewayTransitionReceipt> {
    if (this.disposed) return Promise.reject(new Error("Private voice gateway is disposed"));
    if (candidate.runtime.status.status !== "active") {
      return Promise.reject(new Error("Private voice gateway requires an active candidate"));
    }
    if (this.switchTask !== undefined) return Promise.reject(new Error("Private voice gateway is already switching"));
    this.cancelRetryWork(false);
    this.phase = "switching";
    const task = this.finishActivation(candidate).finally(() => {
      if (this.phase === "switching") this.phase = "normal";
      if (this.switchTask === task) this.switchTask = undefined;
    });
    this.switchTask = task;
    return task;
  }

  /** `swap` names the same atomic active-generation replacement operation. */
  swap(candidate: PrivateVoiceGatewayCandidate): Promise<PrivateVoiceGatewayTransitionReceipt> {
    return this.activate(candidate);
  }

  /** Stops new leases immediately and leaves the stable gateway ready for a later activation. */
  disable(): Promise<PrivateVoiceGatewayTransitionReceipt> {
    if (this.disposed) return Promise.reject(new Error("Private voice gateway is disposed"));
    if (this.switchTask !== undefined) return Promise.reject(new Error("Private voice gateway is already switching"));
    this.cancelRetryWork(false);
    const previous = this.current;
    this.current = undefined;
    this.phase = "normal";
    return Promise.resolve(transitionReceipt(
      previous?.providerGeneration,
      previous === undefined ? Promise.resolve() : this.markDraining(previous),
    ));
  }

  /** Retries only the current degraded runtime, with one bounded single-flight task. */
  retry(): Promise<PrivateVoiceGatewayStatus> {
    const automaticGeneration = this.automaticRetry?.generation;
    this.cancelAutomaticRetry();
    if (this.retryTask !== undefined) {
      if (automaticGeneration !== undefined && this.retryGeneration === automaticGeneration) {
        this.retryCancelled = true;
        if (this.phase === "retrying") this.phase = "normal";
        automaticGeneration.runtime.cancelRetry?.();
        const automaticTask = this.retryTask;
        return automaticTask.then(() => this.retry());
      }
      return this.retryTask;
    }
    if (this.status !== "degraded") return Promise.resolve(this.status);
    const generation = this.current;
    if (generation === undefined) return Promise.resolve("disabled");
    this.cancelledRetryGeneration = undefined;
    this.phase = "retrying";
    this.retryGeneration = generation;
    this.retryCancelled = false;
    const task = this.runRetry(generation).finally(() => {
      if (this.retryTask === task) {
        this.retryTask = undefined;
        this.retryGeneration = undefined;
        this.scheduleAutomaticRetry(generation);
      }
    });
    this.retryTask = task;
    return task;
  }

  /** Cancels the in-progress retry without replacing, disposing, or cancelling a leased generation. */
  cancelRetry(): void {
    this.cancelRetryWork(true);
  }

  private cancelRetryWork(suppressAutomaticRecovery: boolean): void {
    const scheduledGeneration = this.cancelAutomaticRetry();
    if (this.retryTask === undefined || this.retryCancelled) {
      if (suppressAutomaticRecovery && scheduledGeneration !== undefined) this.cancelledRetryGeneration = scheduledGeneration;
      return;
    }
    this.retryCancelled = true;
    if (suppressAutomaticRecovery) this.cancelledRetryGeneration = this.retryGeneration;
    if (this.phase === "retrying") this.phase = "normal";
    const generation = this.retryGeneration;
    generation?.runtime.cancelRetry?.();
  }

  /**
   * Stops new leases and drains every generation. `force` ends the local wait by
   * cancelling and disposing generations that still hold a lease.
   */
  dispose(options: PrivateVoiceGatewayDisposeOptions = {}): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.cancelRetryWork(false);
      if (this.current !== undefined) {
        this.markDraining(this.current);
        this.current = undefined;
      }
      this.disposeTask = Promise.all([...this.generations].map((generation) => this.markDraining(generation))).then(() => undefined);
    }
    if (options.force) this.forceDrain();
    return this.disposeTask ?? Promise.resolve();
  }

  private async finishActivation(candidate: PrivateVoiceGatewayCandidate): Promise<PrivateVoiceGatewayTransitionReceipt> {
    await Promise.resolve();
    if (this.disposed) throw new Error("Private voice gateway is disposed");
    if (candidate.runtime.status.status !== "active") throw new Error("Private voice gateway requires an active candidate");
    const next = this.createGeneration(candidate);
    const previous = this.current;
    this.current = next;
    this.phase = "normal";
    return transitionReceipt(
      previous?.providerGeneration,
      previous === undefined ? Promise.resolve() : this.markDraining(previous),
    );
  }

  private async runRetry(generation: Generation): Promise<PrivateVoiceGatewayStatus> {
    for (let attempt = 0; attempt < this.maxRetryAttempts; attempt += 1) {
      try {
        await generation.runtime.retry();
      } catch {
        // The runtime status remains the provider-detail-free source of retry outcome.
      }
      if (this.retryCancelled || this.disposed || this.current !== generation) return this.status;
      if (generation.runtime.status.status === "active") {
        this.phase = "normal";
        return "active";
      }
    }
    if (!this.retryCancelled && !this.disposed && this.current === generation) this.phase = "normal";
    return this.status;
  }

  private observeLeaseOperation<TResult>(generation: Generation, operation: Promise<TResult>): Promise<TResult> {
    return operation.finally(() => this.scheduleAutomaticRetry(generation));
  }

  private scheduleAutomaticRetry(generation: Generation): void {
    if (!this.canAutomaticallyRetry(generation)) return;
    const active = this.automaticRetry;
    if (active?.generation === generation) return;
    this.cancelAutomaticRetry();
    const cycle: AutomaticRetryCycle = { generation, attempts: 0, cancel: undefined };
    this.automaticRetry = cycle;
    this.scheduleAutomaticRetryAttempt(cycle);
  }

  private scheduleAutomaticRetryAttempt(cycle: AutomaticRetryCycle): void {
    if (this.automaticRetry !== cycle || !this.canAutomaticallyRetry(cycle.generation)) {
      if (this.automaticRetry === cycle) this.automaticRetry = undefined;
      return;
    }
    if (cycle.attempts >= this.maxRetryAttempts) {
      this.automaticRetry = undefined;
      return;
    }
    const delayMs = boundedRetryDelay(this.retryDelayMs(cycle.attempts + 1));
    let cancelled = false;
    const cancelTimer = this.scheduleRetry(() => {
      if (cancelled) return;
      cancelled = true;
      if (cycle.cancel !== undefined) cycle.cancel = undefined;
      void this.runAutomaticRetryAttempt(cycle);
    }, delayMs);
    if (typeof cancelTimer !== "function") throw new TypeError("Private voice gateway retry scheduler is invalid");
    cycle.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      cancelTimer();
    };
  }

  private runAutomaticRetryAttempt(cycle: AutomaticRetryCycle): void {
    const generation = cycle.generation;
    if (this.automaticRetry !== cycle || !this.canAutomaticallyRetry(generation)) {
      if (this.automaticRetry === cycle) this.automaticRetry = undefined;
      return;
    }
    cycle.attempts += 1;
    this.phase = "retrying";
    this.retryGeneration = generation;
    this.retryCancelled = false;
    const task = this.runOneRetry(generation).finally(() => {
      if (this.retryTask !== task) return;
      this.retryTask = undefined;
      this.retryGeneration = undefined;
      if (this.automaticRetry !== cycle) return;
      if (this.canAutomaticallyRetry(generation)) this.scheduleAutomaticRetryAttempt(cycle);
      else this.automaticRetry = undefined;
    });
    this.retryTask = task;
  }

  private async runOneRetry(generation: Generation): Promise<PrivateVoiceGatewayStatus> {
    try {
      await generation.runtime.retry();
    } catch {
      // The runtime status remains the provider-detail-free source of retry outcome.
    }
    if (this.retryCancelled || this.disposed || this.current !== generation) return this.status;
    if (generation.runtime.status.status === "active") {
      this.phase = "normal";
      return "active";
    }
    this.phase = "normal";
    return this.status;
  }

  private canAutomaticallyRetry(generation: Generation): boolean {
    return !this.disposed
      && this.current === generation
      && !generation.draining
      && this.cancelledRetryGeneration !== generation
      && generation.runtime.status.status === "degraded"
      && this.phase !== "switching"
      && this.retryTask === undefined;
  }

  private cancelAutomaticRetry(): Generation | undefined {
    const cycle = this.automaticRetry;
    if (cycle === undefined) return undefined;
    this.automaticRetry = undefined;
    cycle.cancel?.();
    cycle.cancel = undefined;
    return cycle.generation;
  }

  private async runLeaseOperation<TResult>(
    leaseSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<TResult>,
    cancelled: TResult,
    isReleased: () => boolean,
  ): Promise<TResult> {
    if (isReleased()) return cancelled;
    const combined = combineAbortSignals(leaseSignal, callerSignal);
    try {
      if (combined.signal.aborted) return cancelled;
      const result = await operation(combined.signal);
      return isReleased() ? cancelled : result;
    } catch (error) {
      if (isReleased() || combined.signal.aborted) return cancelled;
      throw error;
    } finally {
      combined.dispose();
    }
  }

  private createGeneration(candidate: PrivateVoiceGatewayCandidate): Generation {
    if (!Number.isSafeInteger(candidate.configGeneration) || candidate.configGeneration < 0) {
      throw new Error("Private voice gateway requires a non-negative configuration generation");
    }
    if (candidate.providerGeneration.length === 0) throw new Error("Private voice gateway requires a provider generation");
    const generation: Generation = { ...candidate, leases: 0, draining: false, disposed: false, drain: undefined, disposeTask: undefined };
    this.generations.add(generation);
    return generation;
  }

  private markDraining(generation: Generation): Promise<void> {
    if (!generation.draining) {
      generation.draining = true;
      generation.drain = deferred<void>();
    }
    if (generation.leases === 0) void this.disposeGeneration(generation);
    return generation.drain?.promise ?? Promise.resolve();
  }

  private disposeGeneration(generation: Generation): Promise<void> {
    if (generation.disposeTask !== undefined) return generation.disposeTask;
    generation.disposed = true;
    generation.disposeTask = Promise.resolve(generation.runtime.dispose())
      .catch(() => undefined)
      .then(() => {
        generation.drain?.resolve();
        this.generations.delete(generation);
      });
    return generation.disposeTask;
  }

  private forceDrain(): void {
    for (const generation of this.generations) {
      generation.runtime.cancel();
      void this.disposeGeneration(generation);
    }
  }
}

function boundedAttempts(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("Private voice gateway retry attempts must be between 1 and 10");
  }
  return value;
}

function scheduleRetry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function exponentialRetryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("Private voice gateway retry attempt is invalid");
  return Math.min(30_000, 1_000 * (2 ** (attempt - 1)));
}

function boundedRetryDelay(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 120_000) {
    throw new TypeError("Private voice gateway retry delay is invalid");
  }
  return Number(value);
}

function transitionReceipt(
  priorProviderGeneration: string | undefined,
  drained: Promise<void>,
): PrivateVoiceGatewayTransitionReceipt {
  return Object.freeze({
    ...(priorProviderGeneration === undefined ? {} : { priorProviderGeneration }),
    drained,
  });
}

function cancelledTranscription(): PrivateVoiceTranscriptionResult {
  return { status: "failed", reason: "cancelled" };
}

function cancelledSynthesis(): PrivateVoiceSynthesisResult {
  return { status: "failed", reason: "cancelled" };
}

function trackOperation<TResult>(operations: Set<Promise<unknown>>, operation: Promise<TResult>): Promise<TResult> {
  let tracked: Promise<TResult>;
  tracked = operation.finally(() => { operations.delete(tracked); });
  operations.add(tracked);
  return tracked;
}

function combineAbortSignals(leaseSignal: AbortSignal, callerSignal: AbortSignal | undefined): CombinedAbortSignal {
  if (callerSignal === undefined || callerSignal === leaseSignal) {
    return { signal: leaseSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const sources = [leaseSignal, callerSignal];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const source of sources) source.removeEventListener("abort", abort);
  };
  const abort = (): void => {
    dispose();
    controller.abort();
  };
  for (const source of sources) {
    if (source.aborted) {
      abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve: (value) => resolve?.(value) };
}
