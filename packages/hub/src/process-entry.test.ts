import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  PROCESS_SHUTDOWN_TIMEOUT_MS,
  createProcessShutdown,
  startHomeHubProcess,
  type SignalProcess,
} from "./process-entry.js";

class FakeSignalProcess implements SignalProcess {
  readonly handlers = new Map<"SIGINT" | "SIGTERM", () => void>();

  on(signal: "SIGINT" | "SIGTERM", handler: () => void): this {
    this.handlers.set(signal, handler);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", handler: () => void): this {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal);
    return this;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    this.handlers.get(signal)?.();
  }
}

test("the process shutdown controller coalesces normal disposal and records its exit code", async () => {
  let disposeCount = 0;
  const completed: number[] = [];
  const controller = createProcessShutdown(
    async () => { disposeCount += 1; },
    () => { throw new Error("force exit should not be needed"); },
    (code) => completed.push(code),
  );

  await Promise.all([controller.shutdown(0), controller.shutdown(0)]);

  assert.equal(disposeCount, 1);
  assert.deepEqual(completed, [0]);
});

test("a second interrupt escalates to force exit while the first cleanup is pending", async () => {
  let release!: () => void;
  const disposal = new Promise<void>((resolve) => { release = resolve; });
  const forced: number[] = [];
  const controller = createProcessShutdown(
    () => disposal,
    (code) => forced.push(code),
    () => { throw new Error("natural completion should not be used for interrupts"); },
  );

  controller.interrupt(130);
  controller.interrupt(130);
  assert.deepEqual(forced, [130]);

  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("signal handlers are installed only when starting the process and stop owns runtime cleanup", async () => {
  const signals = new FakeSignalProcess();
  let stopped = 0;
  const forced: number[] = [];
  const processRun = await startHomeHubProcess({
    signalProcess: signals,
    createRuntime: async () => ({
      context: new Context(),
      stop: async () => { stopped += 1; },
    }),
    forceExit: (code) => forced.push(code),
    complete: () => undefined,
  });

  assert.equal(signals.handlers.size, 2);
  signals.emit("SIGTERM");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopped, 1);
  assert.deepEqual(forced, [0]);
  assert.equal(signals.handlers.size, 0);
  await processRun.shutdown.shutdown(0);
});

test("SIGINT reports the conventional user-interrupt exit code", async () => {
  const signals = new FakeSignalProcess();
  const forced: number[] = [];
  let stopped = 0;
  await startHomeHubProcess({
    signalProcess: signals,
    createRuntime: async () => ({
      context: new Context(),
      stop: async () => { stopped += 1; },
    }),
    forceExit: (code) => forced.push(code),
  });

  signals.emit("SIGINT");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopped, 1);
  assert.deepEqual(forced, [130]);
});

test("stuck cleanup is forcefully terminated after the configured grace period", async () => {
  const forced: number[] = [];
  const controller = createProcessShutdown(
    () => new Promise<void>(() => undefined),
    (code) => forced.push(code),
    () => undefined,
    5,
  );

  controller.interrupt(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(forced, [0]);
});

test("startup failure is cleaned up and rethrown", async () => {
  const signals = new FakeSignalProcess();
  const startupError = new Error("cannot connect");
  await assert.rejects(
    startHomeHubProcess({
      signalProcess: signals,
      createRuntime: async () => { throw startupError; },
      forceExit: () => { throw new Error("force exit should not be needed"); },
      complete: () => undefined,
    }),
    startupError,
  );
  assert.equal(signals.handlers.size, 0);
});

test("the default shutdown grace is bounded to five seconds", () => {
  assert.equal(PROCESS_SHUTDOWN_TIMEOUT_MS, 5_000);
});
