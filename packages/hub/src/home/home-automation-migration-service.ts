import { createHash, randomBytes } from "node:crypto";

import {
  HOME_AUTOMATION_MIGRATION_LIMITS,
  HomeAutomationMigrationIdempotencyConflictError,
  type HomeAutomationMigrationAssessment,
  type HomeAutomationMigrationCloseReason,
  type HomeAutomationMigrationCreateResult,
  type HomeAutomationMigrationInput,
  type HomeAutomationMigrationRuleAnalysis,
  type HomeAutomationMigrationRuleAssessment,
} from "./home-automation-migration.js";
import type { HomeAutomationMigrationStore } from "./home-automation-migration-store.js";

export type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationCloseReason,
  HomeAutomationMigrationCreateResult,
  HomeAutomationMigrationInput,
  HomeAutomationMigrationRuleAnalysis,
};
export { HomeAutomationMigrationIdempotencyConflictError } from "./home-automation-migration.js";

/**
 * Narrow future bridge-translator seam. The composition root decides whether
 * this port is trusted; request payloads cannot provide or replace it.
 */
export interface HomeAutomationMigrationTranslator {
  assess(
    request: HomeAutomationMigrationTranslatorRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<HomeAutomationMigrationRuleAnalysis | undefined>;
}

/** Source cut owned by the service; callers cannot provide or override it. */
export interface HomeAutomationMigrationTranslatorRequest {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly ruleRef: string;
}

export interface HomeAutomationMigrationRunOptions {
  readonly signal?: AbortSignal;
}

export interface HomeAutomationMigrationServiceOptions {
  readonly store: HomeAutomationMigrationStore;
  readonly clock?: () => string;
  readonly migrationIdFactory?: () => string;
  readonly idempotencyKeyFactory?: () => string;
  readonly translator?: HomeAutomationMigrationTranslator;
}

/**
 * Creates durable, read-only HA migration assessments. It classifies metadata
 * and never writes to a bridge or executes a translated rule.
 */
export class HomeAutomationMigrationService {
  private readonly store: HomeAutomationMigrationStore;
  private readonly clock: () => string;
  private readonly migrationIdFactory: () => string;
  private readonly idempotencyKeyFactory: () => string;
  private readonly translator?: HomeAutomationMigrationTranslator;

  constructor(options: HomeAutomationMigrationServiceOptions) {
    if (!options || !options.store) throw new TypeError("Home automation migration store is required");
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.migrationIdFactory = options.migrationIdFactory ?? create128BitHex;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? create128BitHex;
    this.translator = options.translator;
  }

  async create(input: HomeAutomationMigrationInput, options: HomeAutomationMigrationRunOptions = {}): Promise<HomeAutomationMigrationCreateResult> {
    const normalized = normalizeInput(input);
    const createdAt = this.clock();
    assertTimestamp(createdAt, "migration creation time");
    const idempotencyKey = normalized.idempotencyKey ?? this.idempotencyKeyFactory();
    assert128BitHex(idempotencyKey, "idempotency key");
    const migrationId = this.migrationIdFactory();
    assert128BitHex(migrationId, "migration id");

    const initialRules = normalized.rules.map((rule) => metadataOnlyAssessment(rule));
    const discovered = this.store.discover({
      migrationId,
      idempotencyKey,
      inputDigest: normalized.inputDigest,
      sourceBridgeId: normalized.bridgeId,
      sourceEpochId: normalized.epochId,
      sourceLastSeq: normalized.lastSeq,
      analysisMode: this.translator === undefined ? "metadata_only" : "trusted_neutral",
      rules: initialRules,
      createdAt,
    });
    if (discovered.outcome === "existing") {
      if (discovered.assessment.status !== "discovered") return discovered;
      return { outcome: "existing", assessment: await this.resumeAssessment(discovered.assessment, options.signal) };
    }

    const classified = await this.classify(normalized, options.signal);
    const assessedAt = this.clock();
    assertTimestamp(assessedAt, "migration assessment time");
    const transition = {
      migrationId,
      status: aggregateStatus(classified),
      assessedAt,
      rules: classified,
    } as const;
    if (!this.store.assess(transition)) throw new Error("Migration assessment disappeared before classification");
    const assessment = this.store.get(migrationId);
    if (assessment === undefined) throw new Error("Migration assessment disappeared after classification");
    return { outcome: "created", assessment };
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    return this.store.get(migrationId);
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    return this.store.list();
  }

  replay(input: HomeAutomationMigrationInput & { readonly idempotencyKey: string }): HomeAutomationMigrationAssessment | undefined {
    const normalized = normalizeInput(input);
    assert128BitHex(normalized.idempotencyKey, "idempotency key");
    return this.store.replay({ idempotencyKey: normalized.idempotencyKey, inputDigest: normalized.inputDigest });
  }

  async recover(options: HomeAutomationMigrationRunOptions = {}): Promise<readonly HomeAutomationMigrationAssessment[]> {
    const recovered: HomeAutomationMigrationAssessment[] = [];
    for (const assessment of this.store.recover()) {
      recovered.push(await this.resumeAssessment(assessment, options.signal));
    }
    return recovered;
  }

  /** Re-runs a recoverable needs-attention assessment through the same CAS path. */
  async retry(input: { readonly migrationId: string }, options: HomeAutomationMigrationRunOptions = {}): Promise<HomeAutomationMigrationAssessment | undefined> {
    const current = this.store.get(input?.migrationId);
    if (current === undefined || current.status !== "needs_attention") return current;
    return this.resumeAssessment(current, options.signal);
  }

  closeAssessment(input: { readonly migrationId: string; readonly reason: HomeAutomationMigrationCloseReason }): HomeAutomationMigrationAssessment | undefined {
    const closedAt = this.clock();
    assertTimestamp(closedAt, "migration close time");
    if (!this.store.closeAssessment({ migrationId: input.migrationId, closedAt, reason: input.reason })) return this.store.get(input.migrationId);
    return this.store.get(input.migrationId);
  }

  close(): void {
    this.store.close();
  }

  private async classify(
    source: Pick<NormalizedInput, "bridgeId" | "epochId" | "lastSeq" | "rules">,
    requestedSignal?: AbortSignal,
  ): Promise<HomeAutomationMigrationRuleAssessment[]> {
    const signal = requestedSignal ?? new AbortController().signal;
    const classified: HomeAutomationMigrationRuleAssessment[] = [];
    for (const rule of source.rules) {
      if (this.translator === undefined) {
        classified.push(metadataOnlyAssessment(rule));
        continue;
      }
      if (signal.aborted) {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      let result: HomeAutomationMigrationRuleAnalysis | undefined;
      try {
        result = await this.translator.assess({
          bridgeId: source.bridgeId,
          epochId: source.epochId,
          lastSeq: source.lastSeq,
          ruleRef: rule.ruleRef,
        }, { signal });
      } catch {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      if (signal.aborted || !isStrictAnalysis(result) || result.ruleRef !== rule.ruleRef) {
        classified.push(needsAttentionAssessment(rule));
        continue;
      }
      classified.push(classifyWithAnalysis(rule, result));
    }
    return classified;
  }

  private async resumeAssessment(assessment: HomeAutomationMigrationAssessment, requestedSignal?: AbortSignal): Promise<HomeAutomationMigrationAssessment> {
    const rules: NormalizedRule[] = assessment.rules.map((rule) => ({
      ruleRef: rule.ruleRef,
      ...(rule.name === undefined ? {} : { name: rule.name }),
      ...(rule.enabled === undefined ? {} : { enabled: rule.enabled }),
      ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt }),
    }));
    const classified = await this.classify({
      bridgeId: assessment.sourceBridgeId,
      epochId: assessment.sourceEpochId,
      lastSeq: assessment.sourceLastSeq,
      rules,
    }, requestedSignal);
    const assessedAt = this.clock();
    assertTimestamp(assessedAt, "migration assessment time");
    if (!this.store.assess({
      migrationId: assessment.migrationId,
      status: aggregateStatus(classified),
      assessedAt,
      rules: classified,
    })) return this.store.get(assessment.migrationId) ?? assessment;
    return this.store.get(assessment.migrationId) ?? assessment;
  }
}

interface NormalizedRule {
  readonly ruleRef: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
}

interface NormalizedInput {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly rules: readonly NormalizedRule[];
  readonly idempotencyKey?: string;
  readonly inputDigest: string;
}

function normalizeInput(value: unknown): NormalizedInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ["catalog", "idempotencyKey"]) || !isRecord(value.catalog)) {
    throw new TypeError("Home automation migration input is invalid");
  }
  if (value.idempotencyKey !== undefined) assert128BitHex(value.idempotencyKey, "idempotency key");
  const catalog = value.catalog;
  if (!hasOnlyKeys(catalog, ["bridgeId", "status", "epochId", "lastSeq", "rules"])
    || catalog.status !== "available"
    || !isBoundedText(catalog.bridgeId, HOME_AUTOMATION_MIGRATION_LIMITS.maxBridgeIdLength)
    || !isBoundedText(catalog.epochId, HOME_AUTOMATION_MIGRATION_LIMITS.maxEpochIdLength)
    || !isPositiveSafeInteger(catalog.lastSeq)
    || !Array.isArray(catalog.rules)) {
    if (catalog.status !== "available") throw new TypeError("Foreign rule catalog is unavailable");
    throw new TypeError("Home automation migration catalog is invalid");
  }
  if (catalog.rules.length > HOME_AUTOMATION_MIGRATION_LIMITS.maxRules) {
    throw new TypeError("Home automation migration rules exceed the bound");
  }
  const refs = new Set<string>();
  const rules = catalog.rules.map((value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["ruleRef", "name", "enabled", "updatedAt"])
      || !isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      || refs.has(value.ruleRef)) {
      throw new TypeError("Foreign rule metadata is invalid");
    }
    refs.add(value.ruleRef);
    if (value.name !== undefined && !isBoundedText(value.name, HOME_AUTOMATION_MIGRATION_LIMITS.maxNameLength)) {
      throw new TypeError("Foreign rule metadata is invalid");
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new TypeError("Foreign rule metadata is invalid");
    if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) throw new TypeError("Foreign rule metadata is invalid");
    return {
      ruleRef: value.ruleRef,
      ...(value.name === undefined ? {} : { name: value.name }),
      ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
      ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    } satisfies NormalizedRule;
  });
  const digestInput = {
    catalog: {
      bridgeId: catalog.bridgeId,
      status: "available",
      epochId: catalog.epochId,
      lastSeq: catalog.lastSeq,
      rules,
    },
  };
  const encoded = stableStringify(digestInput);
  if (Buffer.byteLength(encoded, "utf8") > HOME_AUTOMATION_MIGRATION_LIMITS.maxInputBytes) {
    throw new TypeError("Home automation migration input exceeds the byte bound");
  }
  return {
    bridgeId: catalog.bridgeId,
    epochId: catalog.epochId,
    lastSeq: catalog.lastSeq,
    rules,
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey }),
    inputDigest: `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`,
  };
}

function metadataOnlyAssessment(rule: NormalizedRule): HomeAutomationMigrationRuleAssessment {
  return {
    ...rule,
    triggerClass: "metadata_only",
    conditionClass: "metadata_only",
    actionClass: "metadata_only",
    disposition: "metadata_only",
    reason: "translation_unavailable",
  };
}

function needsAttentionAssessment(rule: NormalizedRule): HomeAutomationMigrationRuleAssessment {
  return {
    ...rule,
    triggerClass: "unknown",
    conditionClass: "unknown",
    actionClass: "unknown",
    disposition: "needs_attention",
    reason: "analysis_incomplete",
  };
}

function classifyWithAnalysis(rule: NormalizedRule, result: HomeAutomationMigrationRuleAnalysis): HomeAutomationMigrationRuleAssessment {
  const triggerClass = result.trigger.kind;
  const conditionClass = result.condition.kind;
  const actionClass = result.action.kind;
  if (result.trigger.kind === "unknown" || result.condition.kind === "unknown" || result.action.kind === "unknown") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "needs_attention", reason: "analysis_incomplete" };
  }
  if (result.trigger.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_trigger" };
  }
  if (result.condition.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_condition" };
  }
  if (result.action.kind === "unsupported") {
    return { ...rule, triggerClass, conditionClass, actionClass, disposition: "unsupported", reason: "unsupported_action" };
  }
  return {
    ...rule,
    triggerClass,
    conditionClass: "flat_and",
    actionClass: "reversible",
    sourceFingerprint: result.sourceFingerprint,
    disposition: "eligible",
  };
}

function aggregateStatus(rules: readonly HomeAutomationMigrationRuleAssessment[]): "assessed" | "needs_attention" {
  if (rules.length === 0 || rules.some((rule) => rule.disposition === "needs_attention")) return "needs_attention";
  return "assessed";
}

function isStrictAnalysis(value: unknown): value is HomeAutomationMigrationRuleAnalysis {
  const baseKeys = ["ruleRef", "trigger", "condition", "action"] as const;
  const eligibleKeys = [...baseKeys, "sourceFingerprint"] as const;
  if (!isRecord(value) || !hasExactKeys(value, baseKeys) && !hasExactKeys(value, eligibleKeys)
    || !isBoundedText(value.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
    || !isRecord(value.trigger) || !hasExactKeys(value.trigger, ["kind"])
    || !isRecord(value.condition) || !hasExactKeys(value.condition, ["kind"])
    || !isRecord(value.action) || !hasExactKeys(value.action, ["kind"])) return false;
  const validTrigger = value.trigger.kind === "state" || value.trigger.kind === "time" || value.trigger.kind === "unsupported" || value.trigger.kind === "unknown";
  const validCondition = value.condition.kind === "flat_and" || value.condition.kind === "unsupported" || value.condition.kind === "unknown";
  const validAction = value.action.kind === "reversible" || value.action.kind === "unsupported" || value.action.kind === "unknown";
  if (!validTrigger || !validCondition || !validAction) return false;
  const isEligible = (value.trigger.kind === "state" || value.trigger.kind === "time")
    && value.condition.kind === "flat_and" && value.action.kind === "reversible";
  if (isEligible) return hasExactKeys(value, eligibleKeys) && isSourceFingerprint(value.sourceFingerprint);
  return hasExactKeys(value, baseKeys);
}

function isSourceFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function create128BitHex(): string {
  return randomBytes(16).toString("hex");
}

function assert128BitHex(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError(`Invalid migration ${label}`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (!isTimestamp(value)) throw new TypeError(`Invalid ${label}`);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && value.trim() === value
    && value.includes("T") && !/[\u0000-\u001F\u007F]/u.test(value) && Number.isFinite(Date.parse(value));
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Home automation migration input is not canonicalizable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
