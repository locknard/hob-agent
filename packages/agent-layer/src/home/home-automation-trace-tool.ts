import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-home-automation-trace-tool";
export const inject = ["tools", "homeWorld"] as const;

const STATUSES = ["complete", "partial", "unknown", "unavailable"] as const;
type HomeAutomationTraceStatus = typeof STATUSES[number];

const COVERAGES = ["exact_run", "rule_only", "not_retained", "not_available"] as const;
type HomeAutomationTraceCoverage = typeof COVERAGES[number];

const RUN_STATES = ["running", "completed", "failed", "unknown"] as const;
type HomeAutomationTraceRunState = typeof RUN_STATES[number];

const RUN_OUTCOMES = ["completed", "condition_not_met", "failed", "cancelled", "unknown"] as const;
type HomeAutomationTraceRunOutcome = typeof RUN_OUTCOMES[number];

const STEP_KINDS = ["trigger", "condition", "action", "wait", "branch", "unknown"] as const;
type HomeAutomationTraceStepKind = typeof STEP_KINDS[number];

const STEP_STATUSES = ["executed", "passed", "skipped", "failed", "unknown"] as const;
type HomeAutomationTraceStepStatus = typeof STEP_STATUSES[number];

const ERROR_KINDS = ["action_failed", "template_failed", "timeout", "unknown"] as const;
type HomeAutomationTraceErrorKind = typeof ERROR_KINDS[number];

/** Reasons are deliberately neutral and finite; provider-specific reasons never cross this seam. */
const REASONS = [
  "association_missing",
  "bridge_not_ready",
  "busy",
  "cancelled",
  "causality_unavailable",
  "invalid_response",
  "not_external_rule",
  "permission_denied",
  "stale_source",
  "target_not_found",
  "timeout",
  "trace_not_retained",
  "trace_unavailable",
  "upstream_unavailable",
] as const;
type HomeAutomationTraceReason = typeof REASONS[number];

const PORT_REASONS: Readonly<Record<string, HomeAutomationTraceReason>> = {
  permission_denied: "permission_denied",
  bridge_not_ready: "bridge_not_ready",
  busy: "busy",
  timeout: "timeout",
  cancelled: "cancelled",
  invalid_response: "invalid_response",
  trace_not_retained: "trace_not_retained",
  rule_not_found: "association_missing",
  association_missing: "association_missing",
  association_stale: "stale_source",
  resync_stale: "stale_source",
  unsupported_trace: "trace_unavailable",
  capability_unavailable: "target_not_found",
  target_not_found: "target_not_found",
  trace_unavailable: "trace_unavailable",
  causality_unavailable: "causality_unavailable",
  journal_unavailable: "upstream_unavailable",
  missing_consistent_baseline: "stale_source",
  target_stale: "stale_source",
  state_not_retained: "association_missing",
  cause_not_retained: "association_missing",
  not_foreign_rule: "not_external_rule",
  not_external_rule: "not_external_rule",
  stale_source: "stale_source",
  upstream_unavailable: "upstream_unavailable",
};

const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_STEPS = 32;
const MAX_REASONS = 32;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export interface HomeAutomationTraceQuery {
  readonly hwCapabilityId: string;
  readonly provenance: {
    readonly bridgeId: string;
    readonly epochId: string;
    readonly seq: number;
  };
}

export interface HomeAutomationTraceRun {
  readonly state: HomeAutomationTraceRunState;
  readonly outcome: HomeAutomationTraceRunOutcome;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface HomeAutomationTraceStep {
  readonly ordinal: number;
  readonly kind: HomeAutomationTraceStepKind;
  readonly status: HomeAutomationTraceStepStatus;
  readonly errorKind?: HomeAutomationTraceErrorKind;
}

export interface HomeAutomationTraceValue {
  readonly status: HomeAutomationTraceStatus;
  readonly coverage: HomeAutomationTraceCoverage;
  readonly automationLabel?: string;
  readonly run?: HomeAutomationTraceRun;
  readonly steps?: HomeAutomationTraceStep[];
  readonly reasons: HomeAutomationTraceReason[];
  readonly truncated: boolean;
}

interface HomeAutomationTracePort {
  queryAutomationTrace(
    input: HomeAutomationTraceQuery,
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
}

type HomeAutomationTraceContext = Context & { homeWorld: HomeAutomationTracePort };

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: STATUSES, required: true },
    coverage: { type: "string", enum: COVERAGES, required: true },
    automationLabel: { type: "string" },
    run: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { type: "string", enum: RUN_STATES, required: true },
        outcome: { type: "string", enum: RUN_OUTCOMES, required: true },
        startedAt: { type: "string" },
        finishedAt: { type: "string" },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ordinal: { type: "integer", required: true },
          kind: { type: "string", enum: STEP_KINDS, required: true },
          status: { type: "string", enum: STEP_STATUSES, required: true },
          errorKind: { type: "string", enum: ERROR_KINDS },
        },
      },
    },
    reasons: {
      type: "array",
      items: { type: "string", enum: REASONS },
      required: true,
    },
    truncated: { type: "boolean", required: true },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_LABEL_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonicalUtcTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const milliseconds = Number((fraction + "000").slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return undefined;
  let offset = 0;
  if (match[8] !== "Z") {
    const sign = match[8][0] === "+" ? 1 : -1;
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    offset = sign * (offsetHour * 60 + offsetMinute);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offset * 60_000;
}

function isStatus(value: unknown): value is HomeAutomationTraceStatus {
  return typeof value === "string" && STATUSES.includes(value as HomeAutomationTraceStatus);
}

function isCoverage(value: unknown): value is HomeAutomationTraceCoverage {
  return typeof value === "string" && COVERAGES.includes(value as HomeAutomationTraceCoverage);
}

function isRunState(value: unknown): value is HomeAutomationTraceRunState {
  return typeof value === "string" && RUN_STATES.includes(value as HomeAutomationTraceRunState);
}

function isRunOutcome(value: unknown): value is HomeAutomationTraceRunOutcome {
  return typeof value === "string" && RUN_OUTCOMES.includes(value as HomeAutomationTraceRunOutcome);
}

function isStepKind(value: unknown): value is HomeAutomationTraceStepKind {
  return typeof value === "string" && STEP_KINDS.includes(value as HomeAutomationTraceStepKind);
}

function isStepStatus(value: unknown): value is HomeAutomationTraceStepStatus {
  return typeof value === "string" && STEP_STATUSES.includes(value as HomeAutomationTraceStepStatus);
}

function isErrorKind(value: unknown): value is HomeAutomationTraceErrorKind {
  return typeof value === "string" && ERROR_KINDS.includes(value as HomeAutomationTraceErrorKind);
}

function validateQuery(value: unknown): HomeAutomationTraceQuery {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["hwCapabilityId", "provenance"])
    || !isBoundedId(value.hwCapabilityId)
    || !isRecord(value.provenance)
    || !hasOnlyKeys(value.provenance, ["bridgeId", "epochId", "seq"])
    || !isBoundedId(value.provenance.bridgeId)
    || !isBoundedId(value.provenance.epochId)
    || typeof value.provenance.seq !== "number"
    || !Number.isSafeInteger(value.provenance.seq)
    || value.provenance.seq < 1) {
    throw new TypeError("home automation trace query is invalid");
  }
  return {
    hwCapabilityId: value.hwCapabilityId,
    provenance: {
      bridgeId: value.provenance.bridgeId,
      epochId: value.provenance.epochId,
      seq: value.provenance.seq,
    },
  };
}

function unavailableTrace(reason: HomeAutomationTraceReason = "trace_unavailable"): HomeAutomationTraceValue {
  return {
    status: "unavailable",
    coverage: "not_available",
    reasons: [reason],
    truncated: false,
  };
}

function invalidTrace(): HomeAutomationTraceValue {
  return unavailableTrace("invalid_response");
}

function validateReasons(value: unknown, requireReason: boolean): HomeAutomationTraceReason[] | undefined {
  if (!Array.isArray(value)
    || value.length > MAX_REASONS
    || (requireReason && value.length === 0)) return undefined;
  const reasons: HomeAutomationTraceReason[] = [];
  for (const reason of value) {
    if (typeof reason !== "string") return undefined;
    const mapped = Object.prototype.hasOwnProperty.call(PORT_REASONS, reason)
      ? PORT_REASONS[reason]
      : undefined;
    if (mapped === undefined || reasons.includes(mapped)) return undefined;
    reasons.push(mapped);
  }
  return reasons;
}

function validateRun(value: unknown): HomeAutomationTraceRun | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasOnlyKeys(value, ["state", "outcome", "startedAt", "finishedAt"])
    || !isRunState(value.state)
    || !isRunOutcome(value.outcome)) return undefined;
  const startedAt = value.startedAt === undefined ? undefined : value.startedAt;
  const finishedAt = value.finishedAt === undefined ? undefined : value.finishedAt;
  const startedMs = startedAt === undefined ? undefined : canonicalUtcTimestampMs(startedAt);
  const finishedMs = finishedAt === undefined ? undefined : canonicalUtcTimestampMs(finishedAt);
  if ((startedAt !== undefined && (typeof startedAt !== "string" || startedMs === undefined))
    || (finishedAt !== undefined && (typeof finishedAt !== "string" || finishedMs === undefined))
    || (startedMs !== undefined && finishedMs !== undefined && finishedMs < startedMs)) {
    return undefined;
  }
  return {
    state: value.state,
    outcome: value.outcome,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

function validateSteps(value: unknown): HomeAutomationTraceStep[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_STEPS) return undefined;
  const steps: HomeAutomationTraceStep[] = [];
  const ordinals = new Set<number>();
  for (const candidate of value) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ["ordinal", "kind", "status", "errorKind"])
      || typeof candidate.ordinal !== "number"
      || !Number.isSafeInteger(candidate.ordinal)
      || candidate.ordinal < 1
      || candidate.ordinal > MAX_STEPS
      || ordinals.has(candidate.ordinal)
      || !isStepKind(candidate.kind)
      || !isStepStatus(candidate.status)
      || (candidate.errorKind !== undefined && !isErrorKind(candidate.errorKind))) {
      return undefined;
    }
    ordinals.add(candidate.ordinal);
    steps.push({
      ordinal: candidate.ordinal,
      kind: candidate.kind,
      status: candidate.status,
      ...(candidate.errorKind === undefined ? {} : { errorKind: candidate.errorKind }),
    });
  }
  return steps;
}

function validateReturnedIdentity(value: Record<string, unknown>, query: HomeAutomationTraceQuery): boolean {
  if (value.hwCapabilityId !== undefined && value.hwCapabilityId !== query.hwCapabilityId) return false;
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)
      || !hasOnlyKeys(value.provenance, ["bridgeId", "epochId", "seq"])
      || value.provenance.bridgeId !== query.provenance.bridgeId
      || value.provenance.epochId !== query.provenance.epochId
      || value.provenance.seq !== query.provenance.seq) return false;
  }
  return true;
}

function projectSafeResult(value: Record<string, unknown>): HomeAutomationTraceValue | undefined {
  if (!hasOnlyKeys(value, [
    "status", "coverage", "hwCapabilityId", "provenance", "automationLabel", "run", "steps", "reasons", "truncated",
  ])) return undefined;
  const status = isStatus(value.status) ? value.status : undefined;
  const coverage = isCoverage(value.coverage) ? value.coverage : undefined;
  if (status === undefined || coverage === undefined
    || !hasOwn(value, "reasons")
    || !hasOwn(value, "truncated")
    || typeof value.truncated !== "boolean") return undefined;
  const reasons = validateReasons(value.reasons, status !== "complete");
  if (reasons === undefined) return undefined;
  if (value.automationLabel !== undefined && !isBoundedLabel(value.automationLabel)) return undefined;
  const validatedRun = value.run === undefined ? undefined : validateRun(value.run);
  if (value.run !== undefined && validatedRun === undefined) return undefined;
  const steps = value.steps === undefined ? undefined : validateSteps(value.steps);
  if (value.steps !== undefined && steps === undefined) return undefined;
  if (status === "complete" && (coverage !== "exact_run" || validatedRun === undefined)) return undefined;
  if (status === "partial" && coverage === "exact_run" && validatedRun === undefined) return undefined;
  if (status === "unknown" && coverage === "exact_run") return undefined;
  if (status === "unavailable" && coverage !== "not_available" && coverage !== "rule_only") return undefined;
  if (status !== "complete" && reasons.length === 0) return undefined;
  return {
    status,
    coverage,
    ...(value.automationLabel === undefined ? {} : { automationLabel: value.automationLabel }),
    ...(validatedRun === undefined ? {} : { run: validatedRun }),
    ...(steps === undefined ? {} : { steps }),
    reasons,
    truncated: value.truncated,
  };
}

function projectTrace(value: unknown, query: HomeAutomationTraceQuery): HomeAutomationTraceValue {
  if (!isRecord(value) || !validateReturnedIdentity(value, query)) return invalidTrace();
  return projectSafeResult(value) ?? invalidTrace();
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_automation_trace",
    description: [
      "Read one bounded, read-only automation execution summary for the exact live evidence event.",
      "First use get_home_causality for that event; call this tool only when it reports external-rule.",
      "Imported recorder history says what and when, never proves why and must not be used to establish this trace.",
      "Only neutral run and step status are returned; rule, trace, context, entity, provider, and raw error references stay inside HomeWorld.",
      "This tool cannot control devices, create proposals, install automations, or change configuration.",
    ].join(" "),
    parameters: {
      hwCapabilityId: { type: "string", required: true },
      provenance: {
        type: "object",
        required: true,
        additionalProperties: false,
        properties: {
          bridgeId: { type: "string", required: true },
          epochId: { type: "string", required: true },
          seq: { type: "integer", required: true },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const query = validateQuery(args);
      const homeWorld = (ctx as HomeAutomationTraceContext).homeWorld;
      try {
        const value = await homeWorld.queryAutomationTrace.call(homeWorld, query, exec.signal);
        return projectTrace(value, query);
      } catch {
        return unavailableTrace();
      }
    },
  }));
}
