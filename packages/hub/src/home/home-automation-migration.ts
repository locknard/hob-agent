import type { HomeWorldForeignRuleCatalog } from "../world/home-world-service.js";

/** The bounded lifecycle owned by the read-only HA migration assessment. Unsupported is a rule disposition, not a lifecycle state. */
export type HomeAutomationMigrationStatus =
  | "discovered"
  | "assessed"
  | "needs_attention"
  | "closed";

export type HomeAutomationMigrationAnalysisMode = "metadata_only" | "trusted_neutral";

export type HomeAutomationMigrationRuleDisposition =
  | "eligible"
  | "metadata_only"
  | "unsupported"
  | "needs_attention";

export type HomeAutomationMigrationRuleClass = "state" | "time" | "reversible" | "metadata_only" | "unsupported" | "unknown";

export type HomeAutomationMigrationConditionClass = "flat_and" | "metadata_only" | "unsupported" | "unknown";

export type HomeAutomationMigrationRuleReason =
  | "translation_unavailable"
  | "unsupported_trigger"
  | "unsupported_condition"
  | "unsupported_action"
  | "analysis_incomplete";

export type HomeAutomationMigrationCloseReason = "household_closed" | "superseded" | "stale_source";

/** A translator result contains only bounded neutral classification. */
export interface HomeAutomationMigrationRuleAnalysis {
  readonly ruleRef: string;
  readonly trigger: {
    readonly kind: "state" | "time" | "unsupported" | "unknown";
  };
  readonly condition: {
    readonly kind: "flat_and" | "unsupported" | "unknown";
  };
  readonly action: {
    readonly kind: "reversible" | "unsupported" | "unknown";
  };
  /** Translator-owned identity for the native configuration behind an eligible translation. */
  readonly sourceFingerprint?: string;
}

/**
 * Input projected from the existing neutral `HomeWorldForeignRuleCatalog`.
 * `catalog` remains metadata-only; native rule content and caller-supplied
 * analysis are not accepted here. Eligibility comes only from the injected
 * translator port owned by the composition root.
 */
export interface HomeAutomationMigrationInput {
  readonly catalog: HomeWorldForeignRuleCatalog;
  /** Optional retry key. The server creates a 128-bit key when omitted. */
  readonly idempotencyKey?: string;
}

export interface HomeAutomationMigrationRuleAssessment {
  readonly ruleRef: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
  readonly triggerClass: HomeAutomationMigrationRuleClass;
  readonly conditionClass: HomeAutomationMigrationConditionClass;
  readonly actionClass: HomeAutomationMigrationRuleClass;
  readonly sourceFingerprint?: string;
  readonly disposition: HomeAutomationMigrationRuleDisposition;
  readonly reason?: HomeAutomationMigrationRuleReason;
}

/** Bounded, restart-safe assessment data. It contains no native rule body. */
export interface HomeAutomationMigrationAssessment {
  readonly migrationId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly analysisMode: HomeAutomationMigrationAnalysisMode;
  readonly rules: readonly HomeAutomationMigrationRuleAssessment[];
  readonly status: HomeAutomationMigrationStatus;
  readonly createdAt: string;
  readonly assessedAt?: string;
  readonly closedAt?: string;
  readonly closedFrom?: Exclude<HomeAutomationMigrationStatus, "closed">;
  readonly closeReason?: HomeAutomationMigrationCloseReason;
}

export interface HomeAutomationMigrationDiscovery {
  readonly migrationId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly analysisMode: HomeAutomationMigrationAnalysisMode;
  readonly rules: readonly HomeAutomationMigrationRuleAssessment[];
  readonly createdAt: string;
}

export interface HomeAutomationMigrationAssessmentTransition {
  readonly migrationId: string;
  readonly status: Exclude<HomeAutomationMigrationStatus, "discovered" | "closed">;
  readonly assessedAt: string;
  readonly rules: readonly HomeAutomationMigrationRuleAssessment[];
}

export interface HomeAutomationMigrationCloseCommand {
  readonly migrationId: string;
  readonly closedAt: string;
  readonly reason: HomeAutomationMigrationCloseReason;
}

export interface HomeAutomationMigrationCreateResult {
  readonly outcome: "created" | "existing";
  readonly assessment: HomeAutomationMigrationAssessment;
}

export class HomeAutomationMigrationIdempotencyConflictError extends Error {
  constructor() {
    super("Home automation migration idempotency key conflicts with a different input");
    this.name = "HomeAutomationMigrationIdempotencyConflictError";
  }
}

export const HOME_AUTOMATION_MIGRATION_LIMITS = Object.freeze({
  maxRules: 256,
  maxRuleRefLength: 200,
  maxNameLength: 256,
  maxBridgeIdLength: 200,
  maxEpochIdLength: 256,
  maxInputBytes: 64 * 1024,
});
