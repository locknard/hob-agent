import assert from "node:assert/strict";
import test from "node:test";

import {
  PrivateVoiceGateway,
  type PrivateVoiceGatewayRuntime,
} from "./private-voice-gateway.js";
import type {
  PrivateVoiceProviderRuntimeStatus,
  PrivateVoiceSynthesisInput,
  PrivateVoiceSynthesisResult,
  PrivateVoiceTranscriptionInput,
  PrivateVoiceTranscriptionResult,
} from "./private-voice-provider-runtime.js";

class FakeRuntime implements PrivateVoiceGatewayRuntime {
  status: PrivateVoiceProviderRuntimeStatus;
  readonly transcriptions: string[] = [];
  readonly syntheses: string[] = [];
  retryCalls = 0;
  retryCancelCalls = 0;
  cancelCalls = 0;
  disposeCalls = 0;
  retryHandler: (() => Promise<PrivateVoiceProviderRuntimeStatus>) | undefined;
  transcribeHandler: ((input: PrivateVoiceTranscriptionInput) => Promise<PrivateVoiceTranscriptionResult>) | undefined;
  synthesizeHandler: ((input: PrivateVoiceSynthesisInput) => Promise<PrivateVoiceSynthesisResult>) | undefined;

  constructor(
    readonly id: string,
    readonly captureMode: "encoded_audio" | "pcm_s16le",
    status: PrivateVoiceProviderRuntimeStatus = { status: "active" },
  ) {
    this.status = status;
  }

  async transcribe(_input: PrivateVoiceTranscriptionInput): Promise<PrivateVoiceTranscriptionResult> {
    this.transcriptions.push(this.id);
    if (this.transcribeHandler !== undefined) return this.transcribeHandler(_input);
    return { status: "transcribed", text: this.id };
  }

  async synthesize(_input: PrivateVoiceSynthesisInput): Promise<PrivateVoiceSynthesisResult> {
    this.syntheses.push(this.id);
    if (this.synthesizeHandler !== undefined) return this.synthesizeHandler(_input);
    return { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) };
  }

  async retry(): Promise<PrivateVoiceProviderRuntimeStatus> {
    this.retryCalls += 1;
    this.status = await (this.retryHandler?.() ?? Promise.resolve(this.status));
    return this.status;
  }

  cancel(): void { this.cancelCalls += 1; }
  cancelRetry(): void { this.retryCancelCalls += 1; }
  async dispose(): Promise<void> { this.disposeCalls += 1; }
}

function candidate(runtime: FakeRuntime, providerGeneration = runtime.id) {
  return { configGeneration: 7, providerGeneration, runtime };
}

class FakeRetryScheduler {
  readonly delays: number[] = [];
  private readonly tasks: Array<{ readonly callback: () => void; cancelled: boolean }> = [];

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    this.delays.push(delayMs);
    const task = { callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };

  async runNext(): Promise<void> {
    const task = this.tasks.shift();
    assert.ok(task, "an automatic retry should be scheduled");
    if (!task.cancelled) task.callback();
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("does not create a lease while private voice is disabled or degraded", () => {
  const disabled = new PrivateVoiceGateway();
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.beginTurn(), undefined);

  const degradedRuntime = new FakeRuntime("degraded", "encoded_audio", { status: "degraded", reason: "unavailable" });
  const degraded = new PrivateVoiceGateway(candidate(degradedRuntime));
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.beginTurn(), undefined);
});

test("pins capture mode and both turn calls to the leased provider generation across a swap", async () => {
  const oldRuntime = new FakeRuntime("provider-old", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(oldRuntime, "provider-generation-1"));
  const oldLease = gateway.beginTurn();
  assert.ok(oldLease);
  assert.equal(Object.isFrozen(oldLease), true);
  assert.equal(oldLease.captureMode, "encoded_audio");
  assert.equal(oldLease.providerGeneration, "provider-generation-1");

  const newRuntime = new FakeRuntime("provider-new", "pcm_s16le");
  const transition = await gateway.activate(candidate(newRuntime, "provider-generation-2"));
  assert.equal(transition.priorProviderGeneration, "provider-generation-1");
  const newLease = gateway.beginTurn();
  assert.ok(newLease);
  assert.equal(newLease.captureMode, "pcm_s16le");
  assert.equal(newLease.providerGeneration, "provider-generation-2");

  assert.deepEqual(await oldLease.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), { status: "transcribed", text: "provider-old" });
  assert.deepEqual(await oldLease.synthesize({ text: "old reply" }), { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  assert.deepEqual(await newLease.transcribe({ audio: new Uint8Array([2]), mimeType: "audio/l16" }), { status: "transcribed", text: "provider-new" });
  assert.deepEqual(await newLease.synthesize({ text: "new reply" }), { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  assert.deepEqual(oldRuntime.transcriptions, ["provider-old"]);
  assert.deepEqual(oldRuntime.syntheses, ["provider-old"]);
  assert.deepEqual(newRuntime.transcriptions, ["provider-new"]);
  assert.deepEqual(newRuntime.syntheses, ["provider-new"]);
  assert.equal(oldRuntime.disposeCalls, 0);

  await oldLease.release();
  await transition.drained;
  assert.equal(oldRuntime.disposeCalls, 1);
  await newLease.release();
});

test("disables new leases while the current generation drains, then activates again through the same gateway", async () => {
  const oldRuntime = new FakeRuntime("provider-old", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(oldRuntime, "provider-generation-1"));
  const lease = gateway.beginTurn();
  assert.ok(lease);

  const disabling = gateway.disable();
  assert.equal(gateway.status, "disabled");
  assert.equal(gateway.beginTurn(), undefined);
  const transition = await disabling;
  assert.equal(transition.priorProviderGeneration, "provider-generation-1");
  assert.equal(oldRuntime.disposeCalls, 0);
  await lease.release();
  await transition.drained;
  assert.equal(oldRuntime.disposeCalls, 1);

  const newRuntime = new FakeRuntime("provider-new", "pcm_s16le");
  const activation = await gateway.activate(candidate(newRuntime, "provider-generation-2"));
  assert.equal(activation.priorProviderGeneration, undefined);
  await activation.drained;
  assert.equal(gateway.beginTurn()?.providerGeneration, "provider-generation-2");
  await gateway.dispose({ force: true });
});

test("keeps issuing complete old-generation leases until an active candidate becomes the new source", async () => {
  const oldRuntime = new FakeRuntime("provider-old", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(oldRuntime));
  const newRuntime = new FakeRuntime("provider-new", "pcm_s16le");
  const switching = gateway.swap(candidate(newRuntime));
  assert.equal(gateway.status, "switching");
  const oldLease = gateway.beginTurn();
  assert.equal(oldLease?.providerGeneration, "provider-old");
  assert.equal(oldLease?.captureMode, "encoded_audio");
  await switching;
  assert.equal(gateway.status, "active");
  assert.equal(gateway.beginTurn()?.providerGeneration, "provider-new");
  await oldLease?.release();
  await gateway.dispose({ force: true });
});

test("release and gateway disposal are idempotent and force disposal can end a draining lease", async () => {
  const runtime = new FakeRuntime("provider-1", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(runtime));
  const lease = gateway.beginTurn();
  assert.ok(lease);
  const release = lease.release();
  assert.strictEqual(release, lease.release());
  await release;
  assert.equal(runtime.disposeCalls, 0);

  const activeLease = gateway.beginTurn();
  assert.ok(activeLease);
  const waitingForDrain = gateway.dispose();
  assert.equal(gateway.status, "disabled");
  assert.equal(gateway.beginTurn(), undefined);
  assert.equal(runtime.disposeCalls, 0);
  await gateway.dispose({ force: true });
  await waitingForDrain;
  assert.equal(runtime.disposeCalls, 1);
  await activeLease.release();
  assert.equal(runtime.disposeCalls, 1);
});

test("releasing a lease aborts only its in-flight operation, rejects later calls, and drains after another lease completes", async () => {
  const runtime = new FakeRuntime("provider-1", "encoded_audio");
  let operationSignal: AbortSignal | undefined;
  let operationStarted: (() => void) | undefined;
  runtime.transcribeHandler = (input) => new Promise((resolve) => {
    operationSignal = input.signal;
    operationSignal?.addEventListener("abort", () => resolve({ status: "failed", reason: "cancelled" }), { once: true });
    operationStarted?.();
  });
  const gateway = new PrivateVoiceGateway(candidate(runtime));
  const releasedLease = gateway.beginTurn();
  const continuingLease = gateway.beginTurn();
  assert.ok(releasedLease);
  assert.ok(continuingLease);
  const started = new Promise<void>((resolve) => { operationStarted = resolve; });
  const inFlight = releasedLease.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" });
  await started;

  const disabling = await gateway.disable();
  const release = releasedLease.release();
  assert.equal(operationSignal?.aborted, true);
  assert.deepEqual(await inFlight, { status: "failed", reason: "cancelled" });
  await release;
  assert.equal(runtime.disposeCalls, 0);
  assert.deepEqual(await releasedLease.transcribe({ audio: new Uint8Array([2]), mimeType: "audio/wav" }), { status: "failed", reason: "cancelled" });
  assert.deepEqual(await releasedLease.synthesize({ text: "no longer allowed" }), { status: "failed", reason: "cancelled" });
  assert.deepEqual(runtime.transcriptions, ["provider-1"]);
  assert.deepEqual(runtime.syntheses, []);

  assert.deepEqual(await continuingLease.synthesize({ text: "still allowed" }), { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  assert.deepEqual(runtime.syntheses, ["provider-1"]);
  await continuingLease.release();
  await disabling.drained;
  assert.equal(runtime.disposeCalls, 1);
});

test("retries the current degraded generation once at a time and returns to active", async () => {
  const runtime = new FakeRuntime("provider-1", "encoded_audio", { status: "degraded", reason: "unavailable" });
  runtime.retryHandler = async () => runtime.retryCalls === 1
    ? { status: "degraded", reason: "endpoint_unreachable" }
    : { status: "active" };
  const gateway = new PrivateVoiceGateway(candidate(runtime), { maxRetryAttempts: 2 });
  const first = gateway.retry();
  const second = gateway.retry();
  assert.strictEqual(first, second);
  assert.equal(gateway.status, "retrying");
  assert.equal(await first, "active");
  assert.equal(runtime.retryCalls, 2);
  assert.equal(gateway.status, "active");
  await gateway.dispose({ force: true });
});

test("automatically retries one degraded generation with bounded backoff", async () => {
  const scheduler = new FakeRetryScheduler();
  const runtime = new FakeRuntime("provider-1", "encoded_audio", { status: "degraded", reason: "unavailable" });
  runtime.retryHandler = async () => runtime.retryCalls === 1
    ? { status: "degraded", reason: "endpoint_unreachable" }
    : { status: "active" };
  const gateway = new PrivateVoiceGateway(candidate(runtime), {
    maxRetryAttempts: 2,
    scheduleRetry: scheduler.schedule,
    retryDelayMs: (attempt) => attempt * 10,
  });

  assert.equal(gateway.status, "degraded");
  assert.deepEqual(scheduler.delays, [10]);
  await scheduler.runNext();
  assert.equal(runtime.retryCalls, 1);
  assert.equal(gateway.status, "degraded");
  assert.deepEqual(scheduler.delays, [10, 20]);

  await scheduler.runNext();
  assert.equal(runtime.retryCalls, 2);
  assert.equal(gateway.status, "active");
  assert.deepEqual(scheduler.delays, [10, 20]);
  await gateway.dispose({ force: true });
});

test("cancelling automatic recovery preserves a later explicit retry", async () => {
  const scheduler = new FakeRetryScheduler();
  const runtime = new FakeRuntime("provider-1", "encoded_audio", { status: "degraded", reason: "unavailable" });
  runtime.retryHandler = async () => ({ status: "active" });
  const gateway = new PrivateVoiceGateway(candidate(runtime), {
    scheduleRetry: scheduler.schedule,
    retryDelayMs: () => 10,
  });

  gateway.cancelRetry();
  await scheduler.runNext();
  assert.equal(runtime.retryCalls, 0);
  assert.equal(gateway.status, "degraded");

  assert.equal(await gateway.retry(), "active");
  assert.equal(runtime.retryCalls, 1);
  assert.equal(gateway.status, "active");
  await gateway.dispose({ force: true });
});

test("manual retry and lifecycle transitions cancel scheduled automatic recovery", async () => {
  const manualScheduler = new FakeRetryScheduler();
  const manualRuntime = new FakeRuntime("manual", "encoded_audio", { status: "degraded", reason: "unavailable" });
  manualRuntime.retryHandler = async () => ({ status: "active" });
  const manual = new PrivateVoiceGateway(candidate(manualRuntime), { scheduleRetry: manualScheduler.schedule, retryDelayMs: () => 10 });
  assert.equal(await manual.retry(), "active");
  await manualScheduler.runNext();
  assert.equal(manualRuntime.retryCalls, 1);

  const activationScheduler = new FakeRetryScheduler();
  const activatingRuntime = new FakeRuntime("activating", "encoded_audio", { status: "degraded", reason: "unavailable" });
  const activating = new PrivateVoiceGateway(candidate(activatingRuntime), { scheduleRetry: activationScheduler.schedule, retryDelayMs: () => 10 });
  await activating.activate(candidate(new FakeRuntime("replacement", "encoded_audio"), "replacement"));
  await activationScheduler.runNext();
  assert.equal(activatingRuntime.retryCalls, 0);

  const disableScheduler = new FakeRetryScheduler();
  const disablingRuntime = new FakeRuntime("disabling", "encoded_audio", { status: "degraded", reason: "unavailable" });
  const disabling = new PrivateVoiceGateway(candidate(disablingRuntime), { scheduleRetry: disableScheduler.schedule, retryDelayMs: () => 10 });
  await disabling.disable();
  await disableScheduler.runNext();
  assert.equal(disablingRuntime.retryCalls, 0);

  const disposeScheduler = new FakeRetryScheduler();
  const disposingRuntime = new FakeRuntime("disposing", "encoded_audio", { status: "degraded", reason: "unavailable" });
  const disposing = new PrivateVoiceGateway(candidate(disposingRuntime), { scheduleRetry: disposeScheduler.schedule, retryDelayMs: () => 10 });
  await disposing.dispose({ force: true });
  await disposeScheduler.runNext();
  assert.equal(disposingRuntime.retryCalls, 0);
  await manual.dispose({ force: true });
  await activating.dispose({ force: true });
});

test("manual retry replaces an in-flight automatic retry without running providers in parallel", async () => {
  const scheduler = new FakeRetryScheduler();
  const runtime = new FakeRuntime("provider-1", "encoded_audio", { status: "degraded", reason: "unavailable" });
  let finishAutomatic: ((value: PrivateVoiceProviderRuntimeStatus) => void) | undefined;
  runtime.retryHandler = () => runtime.retryCalls === 1
    ? new Promise((resolve) => { finishAutomatic = resolve; })
    : Promise.resolve({ status: "active" });
  const gateway = new PrivateVoiceGateway(candidate(runtime), { scheduleRetry: scheduler.schedule, retryDelayMs: () => 10 });

  await scheduler.runNext();
  assert.equal(gateway.status, "retrying");
  const manual = gateway.retry();
  assert.equal(runtime.retryCancelCalls, 1);
  assert.equal(runtime.retryCalls, 1);

  finishAutomatic?.({ status: "degraded", reason: "endpoint_unreachable" });
  assert.equal(await manual, "active");
  assert.equal(runtime.retryCalls, 2);
  assert.equal(gateway.status, "active");
  await gateway.dispose({ force: true });
});

test("automatic recovery leaves a leased ASR and TTS turn intact", async () => {
  const scheduler = new FakeRetryScheduler();
  const runtime = new FakeRuntime("provider-1", "encoded_audio");
  runtime.transcribeHandler = async () => {
    runtime.status = { status: "degraded", reason: "endpoint_unreachable" };
    return { status: "failed", reason: "endpoint_unreachable" };
  };
  runtime.retryHandler = async () => ({ status: "degraded", reason: "endpoint_unreachable" });
  const gateway = new PrivateVoiceGateway(candidate(runtime), { scheduleRetry: scheduler.schedule, retryDelayMs: () => 10 });
  const lease = gateway.beginTurn();
  assert.ok(lease);

  assert.deepEqual(await lease.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), { status: "failed", reason: "endpoint_unreachable" });
  assert.deepEqual(scheduler.delays, [10]);
  await scheduler.runNext();
  assert.equal(runtime.cancelCalls, 0);
  assert.deepEqual(await lease.synthesize({ text: "keep this turn" }), { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  await lease.release();
  await gateway.dispose({ force: true });
});

test("cancelling retry uses the retry-only seam while an existing lease keeps its ASR and TTS work", async () => {
  const runtime = new FakeRuntime("provider-1", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(runtime));
  const lease = gateway.beginTurn();
  assert.ok(lease);
  runtime.status = { status: "degraded", reason: "unavailable" };
  let finishRetry: ((value: PrivateVoiceProviderRuntimeStatus) => void) | undefined;
  runtime.retryHandler = () => new Promise((resolve) => { finishRetry = resolve; });
  const retry = gateway.retry();
  assert.equal(gateway.status, "retrying");
  gateway.cancelRetry();
  assert.equal(gateway.status, "degraded");
  assert.equal(runtime.retryCancelCalls, 1);
  assert.equal(runtime.cancelCalls, 0);
  assert.deepEqual(await lease.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/wav" }), { status: "transcribed", text: "provider-1" });
  assert.deepEqual(await lease.synthesize({ text: "reply" }), { status: "synthesized", mimeType: "audio/wav", audio: new Uint8Array([1]) });
  finishRetry?.({ status: "active" });
  assert.equal(await retry, "degraded");
  assert.equal(gateway.status, "degraded");

  runtime.retryHandler = async () => ({ status: "active" });
  assert.equal(await gateway.retry(), "active");
  await lease.release();
  await gateway.dispose({ force: true });
});

test("refuses a non-active candidate and keeps its active generation", async () => {
  const oldRuntime = new FakeRuntime("provider-old", "encoded_audio");
  const gateway = new PrivateVoiceGateway(candidate(oldRuntime));
  const degradedRuntime = new FakeRuntime("provider-new", "pcm_s16le", { status: "degraded", reason: "unavailable" });
  await assert.rejects(gateway.activate(candidate(degradedRuntime)), /active candidate/i);
  assert.equal(gateway.status, "active");
  assert.equal(gateway.beginTurn()?.providerGeneration, "provider-old");
  await gateway.dispose({ force: true });
});
