import { Context } from "@deepseek-ai/cordis";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  HomeAutomationMigrationRuntimeService,
  type HomeAutomationMigrationRuntimeAssessmentResult,
  type HomeAutomationMigrationRuntimeAssessOptions,
} from "../home/home-automation-migration-runtime-service.js";
import {
  HomeWorldService,
  type HomeWorldSnapshot,
} from "../world/home-world-service.js";
import {
  readHomeWorldLaunchConfig,
  type HomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "../launch-config.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_ASSESSMENT_TIMEOUT_MS = 300_000;

const ASSESSMENT_STATUSES = ["discovered", "assessed", "needs_attention", "closed"] as const;
const ASSESSMENT_REASONS = ["invalid_input", "catalog_unavailable", "idempotency_conflict"] as const;
const DISPOSITIONS = ["eligible", "metadata_only", "unsupported", "needs_attention"] as const;

export interface HomeMigrationAssessmentOptions {
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly assessmentTimeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (delayMs: number) => Promise<void>;
  /** Test seam; production mounts the existing HomeWorld and migration services once. */
  readonly createRuntime?: (
    config: HomeWorldLaunchConfig,
  ) => HomeMigrationAssessmentRuntime | Promise<HomeMigrationAssessmentRuntime>;
}

export interface HomeMigrationAssessmentRuntime {
  readonly snapshot: () => HomeWorldSnapshot;
  readonly assessBridgeCatalog: (
    bridgeId: string,
    options?: HomeAutomationMigrationRuntimeAssessOptions,
  ) => Promise<HomeAutomationMigrationRuntimeAssessmentResult>;
  readonly close: () => Promise<void> | void;
}

export type HomeMigrationAssessmentReceipt =
  | {
    readonly schemaVersion: "1";
    readonly outcome: "created" | "existing";
    readonly assessmentId: string;
    readonly assessmentStatus: typeof ASSESSMENT_STATUSES[number];
    readonly ruleCount: number;
    readonly eligibleRuleCount: number;
    readonly metadataOnlyRuleCount: number;
    readonly unsupportedRuleCount: number;
    readonly needsAttentionRuleCount: number;
    readonly remoteWritesPerformed: false;
  }
  | {
    readonly schemaVersion: "1";
    readonly outcome: "needs_attention";
    readonly reason: typeof ASSESSMENT_REASONS[number];
    readonly remoteWritesPerformed: false;
  };

/** Parses the one operator input; a bridge id is never inferred from the catalog. */
export function parseHomeMigrationAssessmentArgs(
  args: readonly string[],
): { readonly bridgeId: string } {
  if (args.length === 0) throw new TypeError("--bridge-id is required");
  if (args[0] !== "--bridge-id") throw new TypeError("unknown argument");
  if (args.length < 2) throw new TypeError("--bridge-id is required");
  if (args.length > 2) throw new TypeError("unknown argument");
  const bridgeId = args[1];
  if (!isBoundedId(bridgeId)) throw new TypeError("invalid bridge id");
  return { bridgeId };
}

/** Runs one bounded read-only assessment against the configured HomeWorld. */
export async function assessHomeMigrationEnvironment(
  environment: LaunchEnvironment,
  bridgeId: string,
  options: HomeMigrationAssessmentOptions = {},
): Promise<HomeMigrationAssessmentReceipt> {
  if (!isBoundedId(bridgeId)) throw new TypeError("invalid bridge id");
  const readyTimeoutMs = boundedInteger(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000, 120_000, "ready timeout");
  const pollMs = boundedInteger(options.pollMs ?? DEFAULT_POLL_MS, 10, 5_000, "poll interval");
  const assessmentTimeoutMs = boundedInteger(options.assessmentTimeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS, 1_000, 600_000, "assessment timeout");
  const config = readHomeWorldLaunchConfig(environment);
  if (!config.bridges.some((bridge) => bridge.bridgeId === bridgeId)) {
    throw new Error("configured bridge id is not configured");
  }
  const runtime = await (options.createRuntime ?? createDefaultRuntime)(config);
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;

  try {
    await waitForReadyCut(runtime, bridgeId, readyTimeoutMs, pollMs, wait, now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), assessmentTimeoutMs);
    try {
      const result = await runtime.assessBridgeCatalog(bridgeId, { signal: controller.signal });
      return projectReceipt(result);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await runtime.close();
  }
}

async function waitForReadyCut(
  runtime: Pick<HomeMigrationAssessmentRuntime, "snapshot">,
  bridgeId: string,
  timeoutMs: number,
  pollMs: number,
  wait: (delayMs: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (!selectedBridgeReady(runtime, bridgeId)) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Home Assistant bridge did not reach a ready cut");
    await wait(Math.min(pollMs, remaining));
  }
}

function selectedBridgeReady(
  runtime: Pick<HomeMigrationAssessmentRuntime, "snapshot">,
  bridgeId: string,
): boolean {
  try {
    const snapshot = runtime.snapshot();
    const diagnostics = snapshot.diagnostics.find((item) => item.bridgeId === bridgeId);
    const watermark = snapshot.bridgeWatermarks.find((item) => item.bridgeId === bridgeId);
    return Object.prototype.hasOwnProperty.call(snapshot.bridges, bridgeId)
      && diagnostics?.connectionState === "ready"
      && typeof diagnostics.currentProcessReadyAt === "string"
      && diagnostics.currentProcessReadyAt.length > 0
      && watermark !== undefined;
  } catch {
    return false;
  }
}

function projectReceipt(
  result: HomeAutomationMigrationRuntimeAssessmentResult,
): HomeMigrationAssessmentReceipt {
  if (result.outcome === "needs_attention") {
    if (!isAssessmentReason(result.reason)) throw new Error("Migration assessment returned an invalid reason");
    return {
      schemaVersion: "1",
      outcome: "needs_attention",
      reason: result.reason,
      remoteWritesPerformed: false,
    };
  }

  const assessment = result.assessment;
  if (!isOpaqueId(assessment.migrationId)
    || !isAssessmentStatus(assessment.status)
    || !Array.isArray(assessment.rules)
    || assessment.rules.length > 256) {
    throw new Error("Migration assessment returned an invalid durable record");
  }
  const counts = {
    eligibleRuleCount: 0,
    metadataOnlyRuleCount: 0,
    unsupportedRuleCount: 0,
    needsAttentionRuleCount: 0,
  };
  for (const rule of assessment.rules) {
    if (!isDisposition(rule.disposition)) throw new Error("Migration assessment returned an invalid rule disposition");
    if (rule.disposition === "eligible") counts.eligibleRuleCount += 1;
    else if (rule.disposition === "metadata_only") counts.metadataOnlyRuleCount += 1;
    else if (rule.disposition === "unsupported") counts.unsupportedRuleCount += 1;
    else counts.needsAttentionRuleCount += 1;
  }
  return {
    schemaVersion: "1",
    outcome: result.outcome,
    assessmentId: assessment.migrationId,
    assessmentStatus: assessment.status,
    ruleCount: assessment.rules.length,
    ...counts,
    remoteWritesPerformed: false,
  };
}

async function createDefaultRuntime(config: HomeWorldLaunchConfig): Promise<HomeMigrationAssessmentRuntime> {
  const context = new Context();
  try {
    await context.plugin(HomeWorldService, {
      catalog: config.catalog,
      bridges: config.bridges,
      credentialSource: config.bridgeCredentialSource,
      journalDirectory: config.journalDirectory,
      registryPath: config.registryPath,
      worldModelPath: config.worldModelPath,
    });
    await context.plugin(HomeAutomationMigrationRuntimeService, {
      path: join(config.dataDirectory, "home-automation-migrations.sqlite"),
    });
    return {
      snapshot: () => context.homeWorld.snapshot(),
      assessBridgeCatalog: (bridgeId, options) => context.homeAutomationMigrations.assessBridgeCatalog(bridgeId, options),
      close: () => context.fiber.dispose(),
    };
  } catch {
    await context.fiber.dispose().catch(() => undefined);
    throw new Error("Home migration assessment runtime unavailable");
  }
}

function isAssessmentReason(value: unknown): value is typeof ASSESSMENT_REASONS[number] {
  return (ASSESSMENT_REASONS as readonly unknown[]).includes(value);
}

function isAssessmentStatus(value: unknown): value is typeof ASSESSMENT_STATUSES[number] {
  return (ASSESSMENT_STATUSES as readonly unknown[]).includes(value);
}

function isDisposition(value: unknown): value is typeof DISPOSITIONS[number] {
  return (DISPOSITIONS as readonly unknown[]).includes(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`home migration ${label} is invalid or unbounded`);
  }
  return value;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  let args: { readonly bridgeId: string };
  try {
    args = parseHomeMigrationAssessmentArgs(process.argv.slice(2));
  } catch {
    console.error("hob-agent migration assessment failed");
    process.exitCode = 1;
    args = { bridgeId: "invalid" };
  }
  if (process.exitCode !== 1) {
    void assessHomeMigrationEnvironment(process.env, args.bridgeId).then(
      (receipt) => console.log(JSON.stringify(receipt)),
      () => {
        console.error("hob-agent migration assessment failed");
        process.exitCode = 1;
      },
    );
  }
}
