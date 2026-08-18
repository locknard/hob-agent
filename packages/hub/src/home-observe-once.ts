import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createHomeAgentRuntime,
  type HomeAgentRuntime,
  type HomeAgentRuntimeOptions,
} from "./home-agent-runtime.js";
import { createHomeHubProcessOptions } from "./main.js";
import {
  isHomeWorldReady,
  requestGovernedHomeObservation,
  type HomeObservationOutcome,
  type ObservationPorts,
} from "./home-observation-scheduler.js";
import type { LaunchEnvironment } from "./launch-config.js";
import type { ObservationAuditStore } from "./observation-audit-store.js";
import type { ObservationRunMetrics } from "./observation-audit-store.js";
import type { HomeObservationDisposition } from "@hob-agent/agent-layer/home-observation-report";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_MS = 250;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 300_000;

interface OneShotRuntime {
  readonly context: ObservationPorts & {
    readonly homeObservationAudit: Pick<ObservationAuditStore, "begin" | "complete">;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ObserveHomeOptions {
  readonly readyTimeoutMs?: number;
  readonly readyPollMs?: number;
  readonly observationTimeoutMs?: number;
  readonly wait?: (delayMs: number) => Promise<void>;
  /** Test seam; production mounts the canonical HomeAgentRuntime. */
  readonly createRuntime?: (options: HomeAgentRuntimeOptions) => OneShotRuntime;
}

export type ObserveHomeReport =
  | {
      readonly outcome: "completed";
      readonly proposal: "created" | "none";
      readonly disposition?: HomeObservationDisposition;
    }
  | {
      readonly outcome: "not_run";
      readonly reason: Exclude<HomeObservationOutcome, "proposal_created" | "no_proposal">;
      readonly proposal: "already_pending" | "none";
    };

/** Runs one explicit, bounded Agent observation and always disposes its root. */
export async function observeHomeEnvironment(
  environment: LaunchEnvironment,
  options: ObserveHomeOptions = {},
): Promise<ObserveHomeReport> {
  const readyTimeoutMs = boundedInteger(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000, 300_000, "ready timeout");
  const readyPollMs = boundedInteger(options.readyPollMs ?? DEFAULT_READY_POLL_MS, 10, 5_000, "ready poll");
  const observationTimeoutMs = boundedInteger(
    options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS,
    1_000,
    600_000,
    "observation timeout",
  );
  const configured = createHomeHubProcessOptions(environment).runtime;
  const { observation: _observation, inboxHttp: _inboxHttp, ...runtimeOptions } = configured;
  const runtime = (options.createRuntime ?? defaultRuntimeFactory)(runtimeOptions);
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolveWait) => setTimeout(resolveWait, delayMs)));

  try {
    await runtime.start();
    const auditId = runtime.context.homeObservationAudit.begin({
      trigger: "one_shot",
      startedAt: new Date().toISOString(),
    });
    let auditOutcome: HomeObservationOutcome = "failed";
    let auditDisposition: HomeObservationDisposition | undefined;
    let auditMetrics: ObservationRunMetrics | undefined;
    try {
      const readyDeadline = Date.now() + readyTimeoutMs;
      while (!isHomeWorldReady(runtime.context.homeWorld.snapshot())) {
        const remaining = readyDeadline - Date.now();
        if (remaining <= 0) {
          auditOutcome = "world_not_ready";
          return { outcome: "not_run", reason: "world_not_ready", proposal: "none" };
        }
        await wait(Math.min(readyPollMs, remaining));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), observationTimeoutMs);
      let result: Awaited<ReturnType<typeof requestGovernedHomeObservation>>;
      try {
        result = await requestGovernedHomeObservation(runtime.context, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
      auditOutcome = result.outcome;
      auditDisposition = result.disposition;
      auditMetrics = result.metrics;
      if (result.outcome === "proposal_created") return { outcome: "completed", proposal: "created" };
      if (result.outcome === "no_proposal") return {
        outcome: "completed",
        proposal: "none",
        ...(result.disposition === undefined ? {} : { disposition: result.disposition }),
      };
      return {
        outcome: "not_run",
        reason: result.outcome,
        proposal: result.outcome === "proposal_pending" ? "already_pending" : "none",
      };
    } finally {
      runtime.context.homeObservationAudit.complete({
        id: auditId,
        completedAt: new Date().toISOString(),
        outcome: auditOutcome,
        ...(auditDisposition === undefined ? {} : { disposition: auditDisposition }),
        ...(auditMetrics === undefined ? {} : { metrics: auditMetrics }),
      });
    }
  } finally {
    await runtime.stop();
  }
}

function defaultRuntimeFactory(options: HomeAgentRuntimeOptions): HomeAgentRuntime {
  return createHomeAgentRuntime(options);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`home observation ${label} is invalid or unbounded`);
  }
  return value;
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void observeHomeEnvironment(process.env).then(
    (report) => {
      console.log(JSON.stringify(report));
      if (report.outcome === "not_run" && report.reason !== "proposal_pending") process.exitCode = 1;
    },
    () => {
      console.error("hob-agent one-shot observation failed");
      process.exitCode = 1;
    },
  );
}
