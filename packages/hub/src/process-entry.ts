import type { Context } from "@deepseek-ai/cordis";

import {
  startHomeAgentRuntime,
  type HomeAgentRuntimeOptions,
} from "./home-agent-runtime.js";

/** Maximum grace period before a stuck process is forcefully terminated. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;

export type ProcessSignal = "SIGINT" | "SIGTERM";

/** The small part of Node's process API needed by the signal lifecycle. */
export interface SignalProcess {
  on(signal: ProcessSignal, handler: () => void): unknown;
  removeListener(signal: ProcessSignal, handler: () => void): unknown;
}

/** The lifecycle surface exposed by the Home Hub composition root. */
export interface HomeHubRuntime {
  readonly context: Context;
  stop(): Promise<void>;
}

/** Process-exit controller with bounded and escalating shutdown semantics. */
export interface ProcessShutdown {
  /** Dispose the application and record a natural completion code. */
  shutdown(code: number): Promise<void>;
  /** Dispose the application and force exit; a repeated signal exits now. */
  interrupt(code: number): void;
}

/**
 * Creates one shutdown controller around the whole Cordis application tree.
 *
 * The first shutdown request gets a bounded grace period. A repeated signal
 * escalates to immediate exit, matching the DSH CLI lifecycle contract.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => { process.exit(code); },
  complete: (code: number) => void = (code) => { process.exitCode = code; },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let forceExited = false;

  const clearExitTimeout = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
  };

  const forceExitOnce = (code: number): void => {
    if (forceExited) return;
    forceExited = true;
    clearExitTimeout();
    forceExit(code);
  };

  const completeOnce = (code: number): void => {
    if (completed || forceExited) return;
    completed = true;
    clearExitTimeout();
    complete(code);
  };

  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending;
    timeout = setTimeout(() => forceExitOnce(code), timeoutMs);
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceExitOnce(code);
        else completeOnce(code);
      },
      () => forceExitOnce(code),
    );
    return pending;
  };

  return {
    shutdown: (code) => start(code, false),
    interrupt: (code) => {
      if (pending !== undefined) {
        forceExitOnce(code);
        return;
      }
      void start(code, true);
    },
  };
}

export interface StartHomeHubProcessOptions {
  /** Creates and starts the root Cordis runtime. Signals are live during startup. */
  readonly createRuntime: () => Promise<HomeHubRuntime> | HomeHubRuntime;
  readonly signalProcess?: SignalProcess;
  readonly forceExit?: (code: number) => void;
  readonly complete?: (code: number) => void;
  readonly shutdownTimeoutMs?: number;
}

export interface RunningHomeHubProcess {
  readonly runtime: HomeHubRuntime;
  readonly shutdown: ProcessShutdown;
}

export interface StartHomeAgentProcessOptions
  extends Omit<StartHomeHubProcessOptions, "createRuntime"> {
  readonly runtime: HomeAgentRuntimeOptions;
}

/**
 * Starts the process-level Home Hub lifecycle without import-time side effects.
 *
 * The composition root is injected so this layer owns signal handling and
 * shutdown ordering without creating a second runtime or configuration path.
 */
export async function startHomeHubProcess(
  options: StartHomeHubProcessOptions,
): Promise<RunningHomeHubProcess> {
  const signalProcess = options.signalProcess ?? process;
  let runtime: HomeHubRuntime | undefined;
  let removeSignals = (): void => undefined;

  // Starting is scheduled before listeners are installed, but the callback
  // cannot run until this synchronous setup returns. Signals therefore own
  // teardown across the full startup window.
  const starting = Promise.resolve().then(options.createRuntime);
  const dispose = async (): Promise<void> => {
    try {
      const current = runtime ?? await starting.catch(() => undefined);
      await current?.stop();
    } finally {
      removeSignals();
    }
  };
  const shutdown = createProcessShutdown(
    dispose,
    options.forceExit,
    options.complete,
    options.shutdownTimeoutMs,
  );
  const onSigterm = (): void => shutdown.interrupt(0);
  const onSigint = (): void => shutdown.interrupt(130);
  signalProcess.on("SIGTERM", onSigterm);
  signalProcess.on("SIGINT", onSigint);
  removeSignals = () => {
    signalProcess.removeListener("SIGTERM", onSigterm);
    signalProcess.removeListener("SIGINT", onSigint);
  };

  try {
    runtime = await starting;
    return { runtime, shutdown };
  } catch (error) {
    await shutdown.shutdown(1);
    throw error;
  }
}

/** Starts the repository's Home Agent composition with process ownership. */
export function startHomeAgentProcess(
  options: StartHomeAgentProcessOptions,
): Promise<RunningHomeHubProcess> {
  return startHomeHubProcess({
    ...options,
    createRuntime: () => startHomeAgentRuntime(options.runtime),
  });
}
