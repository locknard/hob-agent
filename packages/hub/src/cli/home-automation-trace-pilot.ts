import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  AUTOMATION_TRACE_EXTENSION_KEY,
  automationTraceResultSchema,
  causalityPayloadSchema,
  envelopeSchema,
  type AutomationTraceHandle,
  type AutomationTraceReason,
  type AutomationTraceResult,
  type BridgeAdapter,
  type Envelope,
} from "@hob/bridge-contract";
import {
  EncryptedFileSecretVault,
  MacOSKeychainSecretVault,
  type SecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import {
  readHomeWorldLaunchConfig,
  readProductBootstrapLaunchConfig,
  type HomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "../launch-config.js";
import { BridgeRegistry, type BridgeConfigEntry } from "../bridge/bridge-registry.js";

const DEFAULT_TIMEOUT_SECONDS = 60;

export type HomeAutomationTracePilotStatus = "complete" | "partial" | "unknown" | "unavailable";
export type HomeAutomationTracePilotRunState = "running" | "completed" | "failed" | "unknown";
export type HomeAutomationTracePilotRunOutcome = "completed" | "condition_not_met" | "failed" | "cancelled" | "unknown";

/** Fixed, non-provider diagnostic vocabulary safe for the pilot's stdout. */
export type HomeAutomationTracePilotReason =
  | "configuration_invalid"
  | "bridge_unavailable"
  | "stream_unavailable"
  | "stream_ended"
  | "trace_unavailable"
  | "timeout"
  | "cancelled"
  | "permission_denied"
  | "trace_not_retained"
  | "association_missing"
  | "association_stale"
  | "unsupported_trace"
  | "invalid_response";

export type HomeAutomationTracePilotReport = Readonly<{
  readonly outcome: "exact_run" | "rule_only" | "not_observed" | "unavailable";
  readonly status?: HomeAutomationTracePilotStatus;
  readonly runState?: HomeAutomationTracePilotRunState;
  readonly runOutcome?: HomeAutomationTracePilotRunOutcome;
  readonly reasons?: readonly HomeAutomationTracePilotReason[];
}>;

export interface HomeAutomationTracePilotAdapterInput {
  readonly config: HomeWorldLaunchConfig;
  readonly bridge: BridgeConfigEntry<unknown>;
}

export interface HomeAutomationTracePilotOptions {
  readonly timeoutSeconds?: number;
  readonly bridgeCredentialVault?: SecretVault;
  /** Test seam; production loads the selected bridge through BridgeRegistry. */
  readonly createAdapter?: (input: HomeAutomationTracePilotAdapterInput) => BridgeAdapter;
  /** Test seam for deterministic timeout coverage. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { readonly cancel: () => void };
  readonly signal?: AbortSignal;
}

/**
 * Waits for one naturally observed foreign-rule causality event and reads only
 * its production exact-run extension. This path never starts HomeWorld, Agent,
 * model, journal, or any device/automation control operation.
 */
export async function runHomeAutomationTracePilot(
  environment: LaunchEnvironment = process.env,
  options: HomeAutomationTracePilotOptions = {},
): Promise<HomeAutomationTracePilotReport> {
  const timeoutSeconds = boundedTimeoutSeconds(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  let adapter: BridgeAdapter | undefined;
  let phase: "configuration" | "adapter" = "configuration";
  try {
    const dataDirectory = readProductBootstrapLaunchConfig(environment).dataDirectory;
    const vault = options.bridgeCredentialVault
      ?? await configuredBridgeCredentialVault(environment, dataDirectory);
    const config = readHomeWorldLaunchConfig(environment, vault);
    const bridge = selectTraceBridge(config.bridges, environment.HOB_TRACE_BRIDGE_ID);
    phase = "adapter";
    adapter = options.createAdapter?.({ config, bridge })
      ?? new BridgeRegistry({
        catalog: config.catalog,
        credentialSource: config.bridgeCredentialSource,
      }).load(bridge);
    return await observeTrace(adapter, timeoutSeconds * 1_000, options);
  } catch {
    return unavailableReport(phase === "configuration" ? "configuration_invalid" : "bridge_unavailable");
  } finally {
    if (adapter !== undefined) {
      try {
        await adapter.control.dispose();
      } catch {
        // A bounded report must not expose adapter errors or prevent cleanup.
      }
    }
  }
}

export function parseHomeAutomationTracePilotArgs(args: readonly string[]): number {
  if (args.length === 0) return DEFAULT_TIMEOUT_SECONDS;
  if (args.length !== 2 || args[0] !== "--timeout-seconds") {
    throw new TypeError("Expected --timeout-seconds <1..900>");
  }
  if (!/^[1-9][0-9]{0,2}$/u.test(args[1]!)) {
    throw new TypeError("Expected --timeout-seconds <1..900>");
  }
  const value = Number(args[1]);
  return boundedTimeoutSeconds(value);
}

function boundedTimeoutSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 900) {
    throw new TypeError("Trace pilot timeout must be an integer from 1 to 900 seconds");
  }
  return value;
}

async function configuredBridgeCredentialVault(
  environment: LaunchEnvironment,
  dataDirectory: string,
): Promise<SecretVault> {
  if (environment.HOB_VAULT_KEY_FILE !== undefined) {
    return EncryptedFileSecretVault.open({ dataDirectory, keyFile: environment.HOB_VAULT_KEY_FILE });
  }
  return new MacOSKeychainSecretVault();
}

function selectTraceBridge(
  bridges: readonly BridgeConfigEntry<unknown>[],
  requestedBridgeId: unknown,
): BridgeConfigEntry<unknown> {
  if (typeof requestedBridgeId !== "string" || requestedBridgeId.trim() === "" || requestedBridgeId !== requestedBridgeId.trim()) {
    throw new TypeError("Trace pilot bridge selection is invalid");
  }
  const matches = bridges.filter((bridge) => bridge.bridgeId === requestedBridgeId);
  if (matches.length !== 1) throw new Error("Trace pilot bridge selection is unavailable");
  return matches[0]!;
}

interface PilotTimer {
  readonly cancel: () => void;
}

interface PilotDeadline {
  readonly expired: Promise<"timeout">;
  readonly timer: PilotTimer;
}

async function observeTrace(
  adapter: BridgeAdapter,
  timeoutMs: number,
  options: HomeAutomationTracePilotOptions,
): Promise<HomeAutomationTracePilotReport> {
  let traceHandle: AutomationTraceHandle | undefined;
  try {
    traceHandle = adapter.extension(AUTOMATION_TRACE_EXTENSION_KEY);
  } catch {
    return unavailableReport("trace_unavailable");
  }
  if (traceHandle === undefined) return unavailableReport("trace_unavailable");

  const controller = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;
  let cancellationResolved = false;
  let resolveCancellation!: () => void;
  const cancellation = new Promise<"cancelled">((resolve) => {
    resolveCancellation = () => {
      if (cancellationResolved) return;
      cancellationResolved = true;
      resolve("cancelled");
    };
  });
  const abortFromExternal = (): void => {
    externallyCancelled = true;
    resolveCancellation();
    controller.abort();
  };
  if (options.signal?.aborted === true) {
    abortFromExternal();
  } else {
    options.signal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const deadline = createDeadline(scheduleTimeout, timeoutMs, () => {
    timedOut = true;
    controller.abort();
  });

  let iterator: AsyncIterator<Envelope> | undefined;
  try {
    let previousState: { readonly epochId: string; readonly seq: number } | undefined;
    let liveStreamReady = false;
    if (timedOut) return notObservedReport("timeout");
    if (externallyCancelled) return notObservedReport("cancelled");
    iterator = adapter.events(controller.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([
        Promise.resolve(iterator.next()).then((result) => ({ kind: "event" as const, result })),
        deadline.expired.then(() => ({ kind: "timeout" as const })),
        cancellation.then(() => ({ kind: "cancelled" as const })),
      ]);
      if (next.kind === "timeout") return notObservedReport("timeout");
      if (next.kind === "cancelled") return notObservedReport("cancelled");
      if (next.result.done) break;
      if (controller.signal.aborted) break;
      const parsedEnvelope = envelopeSchema.safeParse(next.result.value);
      if (!parsedEnvelope.success) return unavailableReport("invalid_response");
      const envelope = parsedEnvelope.data;
      const event = envelope.event;
      if (event.kind === "sync-start") {
        previousState = undefined;
        liveStreamReady = false;
        continue;
      }
      if (event.kind === "sync-complete") {
        previousState = undefined;
        liveStreamReady = true;
        continue;
      }
      if (event.kind === "state") {
        previousState = liveStreamReady && event.state.origin === "observed"
          ? { epochId: envelope.epochId, seq: envelope.seq }
          : undefined;
        continue;
      }
      if (event.kind !== "ext" || event.ext !== "causality@1") {
        previousState = undefined;
        continue;
      }

      const payload = causalityPayloadSchema.safeParse(event.payload);
      if (!payload.success) return unavailableReport("invalid_response");
      const cause = payload.data.cause;
      const exactState = previousState !== undefined
        && previousState.epochId === envelope.epochId
        && previousState.seq === payload.data.refSeq
        && envelope.seq > payload.data.refSeq;
      previousState = undefined;
      if (!exactState || cause.kind !== "foreign_rule") continue;

      return await readTraceSummary(traceHandle, {
        ruleRef: cause.ruleRef,
        target: { epochId: envelope.epochId, seq: payload.data.refSeq },
      }, controller.signal, deadline.expired, cancellation, () => timedOut, () => externallyCancelled);
    }
    return timedOut
      ? notObservedReport("timeout")
      : notObservedReport(externallyCancelled ? "cancelled" : "stream_ended");
  } catch {
    if (timedOut) return notObservedReport("timeout");
    if (externallyCancelled) return notObservedReport("cancelled");
    return unavailableReport("stream_unavailable");
  } finally {
    try {
      deadline.timer.cancel();
    } catch {
      // Timer cleanup is best effort; it cannot replace the bounded report.
    }
    closeAsyncIterator(iterator);
    options.signal?.removeEventListener("abort", abortFromExternal);
    controller.abort();
  }
}

async function readTraceSummary(
  handle: AutomationTraceHandle,
  request: { readonly ruleRef: string; readonly target: { readonly epochId: string; readonly seq: number } },
  signal: AbortSignal,
  deadline: Promise<"timeout">,
  cancellation: Promise<"cancelled">,
  timedOut: () => boolean,
  externallyCancelled: () => boolean,
): Promise<HomeAutomationTracePilotReport> {
  let rawResult: unknown;
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => handle.readTrace(request, { signal }))
        .then((value) => ({ kind: "result" as const, value })),
      deadline.then(() => ({ kind: "timeout" as const })),
      cancellation.then(() => ({ kind: "cancelled" as const })),
    ]);
    if (result.kind === "timeout") return ruleOnlyReport("unavailable", "timeout");
    if (result.kind === "cancelled") return ruleOnlyReport("unavailable", "cancelled");
    rawResult = result.value;
  } catch {
    return ruleOnlyReport("unavailable", externallyCancelled() ? "cancelled" : timedOut() ? "timeout" : "trace_unavailable");
  }
  if (externallyCancelled()) return ruleOnlyReport("unavailable", "cancelled");
  if (timedOut()) return ruleOnlyReport("unavailable", "timeout");
  const parsed = automationTraceResultSchema.safeParse(rawResult);
  if (!parsed.success) return ruleOnlyReport("unavailable", "invalid_response");
  if (parsed.data.ruleRef !== request.ruleRef
    || parsed.data.target.epochId !== request.target.epochId
    || parsed.data.target.seq !== request.target.seq) {
    return ruleOnlyReport("unavailable", "invalid_response");
  }
  return projectTraceResult(parsed.data);
}

function projectTraceResult(result: AutomationTraceResult): HomeAutomationTracePilotReport {
  if (result.status === "complete" || result.status === "partial") {
    const reasons = result.status === "partial" ? mapReasons(result.reasons) : undefined;
    return {
      outcome: "exact_run",
      status: result.status,
      runState: result.run.state,
      runOutcome: result.run.outcome,
      ...(reasons === undefined || reasons.length === 0 ? {} : { reasons }),
    };
  }
  return {
    outcome: "rule_only",
    status: result.status,
    reasons: mapReasons(result.reasons),
  };
}

function unavailableReport(reason: HomeAutomationTracePilotReason): HomeAutomationTracePilotReport {
  return { outcome: "unavailable", status: "unavailable", reasons: [reason] };
}

function notObservedReport(reason: Extract<HomeAutomationTracePilotReason, "timeout" | "cancelled" | "stream_ended">): HomeAutomationTracePilotReport {
  return { outcome: "not_observed", status: "unknown", reasons: [reason] };
}

function ruleOnlyReport(
  status: Extract<HomeAutomationTracePilotStatus, "unknown" | "unavailable">,
  ...reasons: readonly HomeAutomationTracePilotReason[]
): HomeAutomationTracePilotReport {
  const normalized = uniqueReasons(reasons.length === 0 ? ["trace_unavailable"] : reasons);
  return { outcome: "rule_only", status, reasons: normalized };
}

function mapReasons(reasons: readonly AutomationTraceReason[]): readonly HomeAutomationTracePilotReason[] {
  return uniqueReasons(reasons.map((reason): HomeAutomationTracePilotReason => {
    switch (reason) {
      case "permission_denied": return "permission_denied";
      case "trace_not_retained": return "trace_not_retained";
      case "rule_not_found": return "association_missing";
      case "association_missing": return "association_missing";
      case "association_stale": return "association_stale";
      case "resync_stale": return "association_stale";
      case "unsupported_trace": return "unsupported_trace";
      case "invalid_response": return "invalid_response";
      case "timeout": return "timeout";
      case "cancelled": return "cancelled";
      case "bridge_not_ready":
      case "busy":
        return "trace_unavailable";
    }
  }));
}

function uniqueReasons(reasons: readonly HomeAutomationTracePilotReason[]): readonly HomeAutomationTracePilotReason[] {
  return [...new Set(reasons)];
}

function defaultScheduleTimeout(callback: () => void, delayMs: number): PilotTimer {
  const timeout = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(timeout) };
}

function createDeadline(
  scheduleTimeout: (callback: () => void, delayMs: number) => PilotTimer,
  timeoutMs: number,
  onTimeout: () => void,
): PilotDeadline {
  let resolveExpired!: () => void;
  const expired = new Promise<"timeout">((resolve) => {
    resolveExpired = () => resolve("timeout");
  });
  const timer = scheduleTimeout(() => {
    onTimeout();
    resolveExpired();
  }, timeoutMs);
  return { expired, timer };
}

function closeAsyncIterator(iterator: AsyncIterator<Envelope> | undefined): void {
  if (iterator?.return === undefined) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Iterator cleanup is best effort; adapter.dispose remains authoritative.
  }
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  let timeoutSeconds: number;
  try {
    timeoutSeconds = parseHomeAutomationTracePilotArgs(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify(unavailableReport("configuration_invalid")));
    process.exitCode = 1;
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  }
  if (process.exitCode !== 1) {
    void runHomeAutomationTracePilot(process.env, { timeoutSeconds }).then(
      (report) => {
        console.log(JSON.stringify(report));
        if (report.outcome === "unavailable") process.exitCode = 1;
      },
      () => {
        console.log(JSON.stringify(unavailableReport("configuration_invalid")));
        process.exitCode = 1;
      },
    );
  }
}
