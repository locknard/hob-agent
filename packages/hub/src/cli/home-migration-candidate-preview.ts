import { Context } from "@deepseek-ai/cordis";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationRuleAssessment,
} from "../home/home-automation-migration.js";
import {
  HomeAutomationMigrationRuntimeService,
  type HomeAutomationMigrationRuntimeAssessOptions,
  type HomeAutomationMigrationRuntimeCandidateInput,
  type HomeAutomationMigrationRuntimeCandidateResult,
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
const DEFAULT_CANDIDATE_TIMEOUT_MS = 300_000;

const CANDIDATE_REASONS = [
  "assessment_not_eligible",
  "stale_source",
  "translation_unavailable",
  "unsupported",
  "invalid_input",
  "resolver_failed",
  "unbound_target",
  "multiple_targets",
  "invalid_title",
  "artifact_invalid",
  "candidate_unavailable",
  "candidate_timeout",
] as const;

const ASSESSMENT_FAILURE_REASONS = [
  "assessment_not_found",
  "assessment_not_assessed",
  "assessment_inconsistent",
  "source_unavailable",
  "ready_timeout",
  "source_unstable",
] as const;

type CandidateReason = typeof CANDIDATE_REASONS[number];
type AssessmentFailureReason = typeof ASSESSMENT_FAILURE_REASONS[number];

export interface HomeMigrationCandidatePreviewOptions {
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  /** Total budget for the complete eligible-rule preview, not a per-rule budget. */
  readonly candidateTimeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (delayMs: number) => Promise<void>;
  /** Test seam; production mounts the existing HomeWorld and migration services once. */
  readonly createRuntime?: (
    config: HomeWorldLaunchConfig,
  ) => HomeMigrationCandidatePreviewRuntime | Promise<HomeMigrationCandidatePreviewRuntime>;
}

export interface HomeMigrationCandidatePreviewRuntime {
  readonly snapshot: () => HomeWorldSnapshot;
  readonly get: (migrationId: string) => HomeAutomationMigrationAssessment | undefined;
  readonly createArtifactCandidate: (
    input: HomeAutomationMigrationRuntimeCandidateInput,
    options?: HomeAutomationMigrationRuntimeAssessOptions,
  ) => Promise<HomeAutomationMigrationRuntimeCandidateResult>;
  readonly close: () => Promise<void> | void;
}

export type HomeMigrationCandidatePreviewReceipt =
  | {
    readonly schemaVersion: "1";
    readonly outcome: "previewed";
    readonly assessmentId: string;
    readonly eligibleRuleCount: number;
    readonly candidateRuleCount: number;
    readonly needsAttentionRuleCount: number;
    readonly needsAttentionByReason: CandidateReasonCounts;
    readonly remoteWritesPerformed: false;
  }
  | {
    readonly schemaVersion: "1";
    readonly outcome: "needs_attention";
    readonly assessmentId: string;
    readonly reason: AssessmentFailureReason;
    readonly remoteWritesPerformed: false;
  };

type CandidateReasonCounts = { readonly [reason in CandidateReason]: number };

/** Parses the one operator input; an assessment id is never inferred or selected implicitly. */
export function parseHomeMigrationCandidatePreviewArgs(
  args: readonly string[],
): { readonly assessmentId: string } {
  if (args.length === 0) throw new TypeError("--assessment-id is required");
  if (args[0] !== "--assessment-id") throw new TypeError("unknown argument");
  if (args.length < 2) throw new TypeError("--assessment-id is required");
  if (args.length > 2) throw new TypeError("unknown argument");
  const assessmentId = args[1];
  if (!isOpaqueId(assessmentId)) throw new TypeError("invalid assessment id");
  return { assessmentId };
}

/** Previews only durable eligible migration rules and emits aggregate neutral output. */
export async function previewHomeMigrationCandidates(
  environment: LaunchEnvironment,
  assessmentId: string,
  options: HomeMigrationCandidatePreviewOptions = {},
): Promise<HomeMigrationCandidatePreviewReceipt> {
  if (!isOpaqueId(assessmentId)) throw new TypeError("invalid assessment id");
  const readyTimeoutMs = boundedInteger(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000, 120_000, "ready timeout");
  const pollMs = boundedInteger(options.pollMs ?? DEFAULT_POLL_MS, 10, 5_000, "poll interval");
  const candidateTimeoutMs = boundedInteger(options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS, 1, 600_000, "candidate timeout");
  const config = readHomeWorldLaunchConfig(environment);
  const runtime = await (options.createRuntime ?? createDefaultRuntime)(config);
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;

  try {
    let assessment: HomeAutomationMigrationAssessment | undefined;
    try {
      assessment = runtime.get(assessmentId);
    } catch {
      return failClosed(assessmentId, "assessment_inconsistent");
    }
    if (assessment === undefined) return failClosed(assessmentId, "assessment_not_found");
    const assessmentFailure = validateAssessment(assessmentId, assessment);
    if (assessmentFailure !== undefined) return failClosed(assessmentId, assessmentFailure);
    if (!config.bridges.some((bridge) => bridge.bridgeId === assessment.sourceBridgeId)) {
      return failClosed(assessmentId, "source_unavailable");
    }
    try {
      await waitForReadyCut(runtime, assessment.sourceBridgeId, readyTimeoutMs, pollMs, wait, now);
    } catch {
      return failClosed(assessmentId, "ready_timeout");
    }
    if (!sourceWatermarkMatches(runtime, assessment)) {
      return failClosed(assessmentId, "source_unstable");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), candidateTimeoutMs);
    try {
      const receipt = await previewEligibleRules(runtime, assessment, controller.signal);
      return sourceWatermarkMatches(runtime, assessment)
        ? receipt
        : failClosed(assessmentId, "source_unstable");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await runtime.close();
  }
}

async function previewEligibleRules(
  runtime: Pick<HomeMigrationCandidatePreviewRuntime, "createArtifactCandidate">,
  assessment: HomeAutomationMigrationAssessment,
  signal: AbortSignal,
): Promise<HomeMigrationCandidatePreviewReceipt> {
  const eligibleRules = assessment.rules.filter((rule) => rule.disposition === "eligible");
  const needsAttentionByReason = createReasonCounts();
  let candidateRuleCount = 0;
  let needsAttentionRuleCount = 0;

  for (let index = 0; index < eligibleRules.length; index += 1) {
    const rule = eligibleRules[index]!;
    if (signal.aborted) {
      const remaining = eligibleRules.length - index;
      needsAttentionRuleCount += remaining;
      needsAttentionByReason.candidate_timeout += remaining;
      break;
    }

    let result: HomeAutomationMigrationRuntimeCandidateResult;
    try {
      const operation = Promise.resolve().then(() => runtime.createArtifactCandidate(
        { migrationId: assessment.migrationId, ruleRef: rule.ruleRef },
        { signal },
      ));
      result = await raceCandidate(operation, signal);
    } catch (error) {
      needsAttentionRuleCount += 1;
      const reason = signal.aborted || error === CANDIDATE_TIMEOUT
        ? "candidate_timeout"
        : "candidate_unavailable";
      needsAttentionByReason[reason] += 1;
      if (reason === "candidate_timeout") {
        const remaining = eligibleRules.length - index - 1;
        needsAttentionRuleCount += remaining;
        needsAttentionByReason.candidate_timeout += remaining;
        break;
      }
      continue;
    }

    if (result.status === "candidate") {
      candidateRuleCount += 1;
    } else {
      needsAttentionRuleCount += 1;
      needsAttentionByReason[normalizeCandidateReason(result.reason)] += 1;
    }
  }

  return {
    schemaVersion: "1",
    outcome: "previewed",
    assessmentId: assessment.migrationId,
    eligibleRuleCount: eligibleRules.length,
    candidateRuleCount,
    needsAttentionRuleCount,
    needsAttentionByReason,
    remoteWritesPerformed: false,
  };
}

const CANDIDATE_TIMEOUT = Symbol("home migration candidate preview timeout");
type CandidateTimeout = typeof CANDIDATE_TIMEOUT;

async function raceCandidate(
  operation: Promise<HomeAutomationMigrationRuntimeCandidateResult>,
  signal: AbortSignal,
): Promise<HomeAutomationMigrationRuntimeCandidateResult> {
  if (signal.aborted) throw CANDIDATE_TIMEOUT;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(CANDIDATE_TIMEOUT);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function waitForReadyCut(
  runtime: Pick<HomeMigrationCandidatePreviewRuntime, "snapshot">,
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
  runtime: Pick<HomeMigrationCandidatePreviewRuntime, "snapshot">,
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

function sourceWatermarkMatches(
  runtime: Pick<HomeMigrationCandidatePreviewRuntime, "snapshot">,
  assessment: Pick<HomeAutomationMigrationAssessment, "sourceBridgeId" | "sourceEpochId" | "sourceLastSeq">,
): boolean {
  try {
    const matches = runtime.snapshot().bridgeWatermarks.filter((watermark) => watermark.bridgeId === assessment.sourceBridgeId);
    return matches.length === 1
      && matches[0]?.epochId === assessment.sourceEpochId
      && matches[0]?.lastSeq === assessment.sourceLastSeq;
  } catch {
    return false;
  }
}

function validateAssessment(
  assessmentId: string,
  assessment: HomeAutomationMigrationAssessment,
): AssessmentFailureReason | undefined {
  try {
    if (assessment.migrationId !== assessmentId) return "assessment_inconsistent";
    if (assessment.status !== "assessed") return "assessment_not_assessed";
    if (!isBoundedId(assessment.sourceBridgeId, 200)
      || !isBoundedId(assessment.sourceEpochId, 256)
      || !Number.isSafeInteger(assessment.sourceLastSeq)
      || assessment.sourceLastSeq <= 0
      || !Array.isArray(assessment.rules)
      || assessment.rules.length === 0
      || assessment.rules.length > 256) {
      return "assessment_inconsistent";
    }
    const refs = new Set<string>();
    for (const rule of assessment.rules) {
      if (!isConsistentRule(rule) || refs.has(rule.ruleRef)) return "assessment_inconsistent";
      refs.add(rule.ruleRef);
    }
    return undefined;
  } catch {
    return "assessment_inconsistent";
  }
}

function isConsistentRule(rule: HomeAutomationMigrationRuleAssessment): boolean {
  if (!isBoundedId(rule.ruleRef, 200)
    || !isDisposition(rule.disposition)) return false;
  if (rule.disposition === "eligible") {
    return isDigest(rule.sourceFingerprint)
      && rule.reason === undefined
      && rule.workflow !== undefined
      && rule.workflow.sourceFingerprint === rule.sourceFingerprint
      && isWorkflowStatus(rule.workflow.status);
  }
  return rule.sourceFingerprint === undefined
    && rule.workflow === undefined
    && isRuleReason(rule.reason);
}

function createReasonCounts(): { -readonly [reason in CandidateReason]: number } {
  return Object.fromEntries(CANDIDATE_REASONS.map((reason) => [reason, 0])) as { -readonly [reason in CandidateReason]: number };
}

function normalizeCandidateReason(value: unknown): CandidateReason {
  return isCandidateReason(value) ? value : "candidate_unavailable";
}

function isCandidateReason(value: unknown): value is CandidateReason {
  return (CANDIDATE_REASONS as readonly unknown[]).includes(value);
}

function isDisposition(value: unknown): value is HomeAutomationMigrationRuleAssessment["disposition"] {
  return value === "eligible" || value === "metadata_only" || value === "unsupported" || value === "needs_attention";
}

function isRuleReason(value: unknown): boolean {
  return value === "translation_unavailable" || value === "unsupported_trigger"
    || value === "unsupported_condition" || value === "unsupported_action" || value === "analysis_incomplete";
}

function isWorkflowStatus(value: unknown): boolean {
  return value === "assessed" || value === "translated" || value === "simulated" || value === "ready"
    || value === "switching" || value === "verified" || value === "rolling_back"
    || value === "restored" || value === "needs_attention";
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isBoundedId(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && Buffer.byteLength(value, "utf8") <= maximum
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`home migration candidate preview ${label} is invalid or unbounded`);
  }
  return value;
}

function failClosed(
  assessmentId: string,
  reason: AssessmentFailureReason,
): HomeMigrationCandidatePreviewReceipt {
  return {
    schemaVersion: "1",
    outcome: "needs_attention",
    assessmentId,
    reason,
    remoteWritesPerformed: false,
  };
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

async function createDefaultRuntime(config: HomeWorldLaunchConfig): Promise<HomeMigrationCandidatePreviewRuntime> {
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
      get: (migrationId) => context.homeAutomationMigrations.get(migrationId),
      createArtifactCandidate: (input, options) => context.homeAutomationMigrations.createArtifactCandidate(input, options),
      close: () => context.fiber.dispose(),
    };
  } catch {
    await context.fiber.dispose().catch(() => undefined);
    throw new Error("Home migration candidate preview runtime unavailable");
  }
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  let args: { readonly assessmentId: string };
  try {
    args = parseHomeMigrationCandidatePreviewArgs(process.argv.slice(2));
  } catch {
    console.error("hob-agent migration candidate preview failed");
    process.exitCode = 1;
    args = { assessmentId: "invalid" };
  }
  if (process.exitCode !== 1) {
    void previewHomeMigrationCandidates(process.env, args.assessmentId).then(
      (receipt) => console.log(JSON.stringify(receipt)),
      () => {
        console.error("hob-agent migration candidate preview failed");
        process.exitCode = 1;
      },
    );
  }
}
