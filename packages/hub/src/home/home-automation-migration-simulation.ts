import { createHash } from "node:crypto";

import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";

export const HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS = Object.freeze({
  maxEventSamples: 32,
  maxExistingRuleSummaries: 64,
  maxValuesPerEvent: 8,
  maxExpectedActions: 128,
  maxInterferenceRecords: 128,
  maxCapabilityIdLength: 200,
  maxEventIdLength: 200,
  maxMessageLength: 512,
  maxScalarStringBytes: 1024,
  maxReceiptBytes: 64 * 1024,
});

export type HomeAutomationMigrationSimulationScalar = string | number | boolean | null;

export interface HomeAutomationMigrationSimulationSourceCut {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  /** The source configuration hash bound to this exact watermark. */
  readonly configFingerprint: string;
}

export interface HomeAutomationMigrationSimulationValue {
  readonly capabilityId: string;
  readonly value: HomeAutomationMigrationSimulationScalar;
}

export type HomeAutomationMigrationSimulationEvent =
  | {
    readonly eventId: string;
    readonly kind: "capability_changed";
    readonly occurredAt: string;
    readonly capabilityId: string;
    readonly values: readonly HomeAutomationMigrationSimulationValue[];
  }
  | {
    readonly eventId: string;
    readonly kind: "schedule";
    readonly occurredAt: string;
    readonly timezone: string;
    readonly daysOfWeek: readonly number[];
    readonly at: string;
    readonly values: readonly HomeAutomationMigrationSimulationValue[];
  };

export type HomeAutomationMigrationExistingRuleTrigger =
  | {
    readonly kind: "capability_changed";
    readonly sourceCapabilityId: string;
  }
  | {
    readonly kind: "schedule";
    readonly timezone: string;
    readonly daysOfWeek: readonly number[];
    readonly at: string;
  };

export type HomeAutomationMigrationExistingRuleAction =
  | {
    readonly kind: "set_boolean";
    readonly targetCapabilityId: string;
    readonly value: boolean;
  }
  | {
    readonly kind: "set_level";
    readonly targetCapabilityId: string;
    readonly value: number;
  }
  | {
    readonly kind: "notify_local";
    readonly message: string;
  };

export interface HomeAutomationMigrationExistingRuleSummary {
  readonly ruleRef: string;
  readonly enabled: boolean;
  readonly trigger: HomeAutomationMigrationExistingRuleTrigger;
  readonly actions: readonly HomeAutomationMigrationExistingRuleAction[];
}

export interface HomeAutomationMigrationDualRunInput {
  readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
  readonly candidate: ForeignRuleArtifactCandidate;
  readonly preparation: HomeAutomationMigrationSimulationPreparation;
  readonly eventSamples: readonly HomeAutomationMigrationSimulationEvent[];
  readonly existingRuleSummaries: readonly HomeAutomationMigrationExistingRuleSummary[];
}

export interface HomeAutomationMigrationSimulationPreparation {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly artifactContentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

/** Server-owned read-only evidence seam; browser callers cannot supply it. */
export interface HomeAutomationMigrationSimulationEvidencePort {
  read(input: {
    readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
    readonly candidate: ForeignRuleArtifactCandidate;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
    readonly eventSamples: readonly HomeAutomationMigrationSimulationEvent[];
    readonly existingRuleSummaries: readonly HomeAutomationMigrationExistingRuleSummary[];
  } | undefined> | {
    readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
    readonly eventSamples: readonly HomeAutomationMigrationSimulationEvent[];
    readonly existingRuleSummaries: readonly HomeAutomationMigrationExistingRuleSummary[];
  } | undefined;
}

export interface HomeAutomationMigrationExpectedTrigger {
  readonly eventId: string;
  readonly triggered: boolean;
  readonly conditionsSatisfied: boolean;
}

export type HomeAutomationMigrationExpectedAction =
  | {
    readonly eventId: string;
    readonly actionOrder: number;
    readonly kind: "set_boolean";
    readonly targetCapabilityId: string;
    readonly value: boolean;
  }
  | {
    readonly eventId: string;
    readonly actionOrder: number;
    readonly kind: "set_level";
    readonly targetCapabilityId: string;
    readonly value: number;
  }
  | {
    readonly eventId: string;
    readonly actionOrder: number;
    readonly kind: "notify_local";
    readonly message: string;
  };

export type HomeAutomationMigrationSimulationInterferenceReason =
  | "same_trigger"
  | "same_trigger_and_shared_target";

export interface HomeAutomationMigrationExistingRuleInterference {
  readonly eventId: string;
  readonly ruleRef: string;
  readonly reason: HomeAutomationMigrationSimulationInterferenceReason;
  readonly sharedCapabilityIds: readonly string[];
  readonly existingActionKinds: readonly HomeAutomationMigrationExistingRuleAction["kind"][];
}

export interface HomeAutomationMigrationSimulationReceipt {
  readonly schemaVersion: "1";
  readonly kind: "home-automation-migration-simulation";
  readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
  readonly sourceFingerprint: string;
  readonly candidateContentHash: string;
  readonly preparation: HomeAutomationMigrationSimulationPreparation;
  readonly expectedTriggers: readonly HomeAutomationMigrationExpectedTrigger[];
  readonly expectedActions: readonly HomeAutomationMigrationExpectedAction[];
  readonly existingRuleInterference: readonly HomeAutomationMigrationExistingRuleInterference[];
  readonly simulationDigest: string;
  readonly writesPerformed: false;
}

export type HomeAutomationMigrationSimulationReason =
  | "invalid_input"
  | "stale"
  | "ambiguous"
  | "unsupported"
  | "over_limit";

export type HomeAutomationMigrationDualRunResult =
  | {
    readonly status: "simulated";
    readonly receipt: HomeAutomationMigrationSimulationReceipt;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationSimulationReason;
    readonly writesPerformed: false;
  };

export function parseHomeAutomationMigrationSimulationReceipt(value: unknown): HomeAutomationMigrationSimulationReceipt {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion", "kind", "sourceCut", "sourceFingerprint", "candidateContentHash", "preparation",
      "expectedTriggers", "expectedActions", "existingRuleInterference", "simulationDigest", "writesPerformed",
    ])
    || value.schemaVersion !== "1"
    || value.kind !== "home-automation-migration-simulation"
    || value.writesPerformed !== false
    || !isDigest(value.sourceFingerprint)
    || !isDigest(value.candidateContentHash)
    || !isDigest(value.simulationDigest)) {
    throw new TypeError("Home automation migration simulation receipt is invalid");
  }
  const sourceCut = parseSourceCut(value.sourceCut);
  const preparation = parsePreparation(value.preparation);
  const expectedTriggers = parseExpectedTriggers(value.expectedTriggers);
  const expectedActions = parseExpectedActions(value.expectedActions);
  const existingRuleInterference = parseInterference(value.existingRuleInterference);
  const receipt = Object.freeze({
    schemaVersion: "1" as const,
    kind: "home-automation-migration-simulation" as const,
    sourceCut,
    sourceFingerprint: value.sourceFingerprint,
    candidateContentHash: value.candidateContentHash,
    preparation,
    expectedTriggers,
    expectedActions,
    existingRuleInterference,
    simulationDigest: value.simulationDigest,
    writesPerformed: false as const,
  });
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxReceiptBytes
    || computeHomeAutomationMigrationSimulationDigest(receipt) !== receipt.simulationDigest) {
    throw new TypeError("Home automation migration simulation receipt is invalid");
  }
  return receipt;
}

function parsePreparation(value: unknown): HomeAutomationMigrationSimulationPreparation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId",
  ]) || !isBoundedText(value.artifactId, 200)
    || !isPositiveSafeInteger(value.artifactRevision)
    || !isDigest(value.artifactContentHash)
    || !isDigest(value.compileResultId)
    || !isDigest(value.dryRunResultId)) {
    throw new TypeError("Home automation migration simulation preparation is invalid");
  }
  return Object.freeze({
    artifactId: value.artifactId,
    artifactRevision: value.artifactRevision,
    artifactContentHash: value.artifactContentHash,
    compileResultId: value.compileResultId,
    dryRunResultId: value.dryRunResultId,
  });
}

export function isHomeAutomationMigrationSimulationReceipt(value: unknown): value is HomeAutomationMigrationSimulationReceipt {
  try {
    parseHomeAutomationMigrationSimulationReceipt(value);
    return true;
  } catch {
    return false;
  }
}

export function computeHomeAutomationMigrationSimulationDigest(
  value: Omit<HomeAutomationMigrationSimulationReceipt, "simulationDigest"> | HomeAutomationMigrationSimulationReceipt,
): string {
  const { simulationDigest: _ignored, ...withoutDigest } = value as HomeAutomationMigrationSimulationReceipt;
  return digestCanonical(withoutDigest);
}

export function canonicalSimulationJson(value: unknown): string {
  return canonicalJson(value);
}

function parseSourceCut(value: unknown): HomeAutomationMigrationSimulationSourceCut {
  if (!isRecord(value) || !hasExactKeys(value, ["bridgeId", "epochId", "lastSeq", "configFingerprint"])
    || !isBoundedText(value.bridgeId, 200)
    || !isBoundedText(value.epochId, 256)
    || !isPositiveSafeInteger(value.lastSeq)
    || !isDigest(value.configFingerprint)) {
    throw new TypeError("Home automation migration simulation source cut is invalid");
  }
  return Object.freeze({
    bridgeId: value.bridgeId,
    epochId: value.epochId,
    lastSeq: value.lastSeq,
    configFingerprint: value.configFingerprint,
  });
}

function parseExpectedTriggers(value: unknown): readonly HomeAutomationMigrationExpectedTrigger[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventSamples) {
    throw new TypeError("Home automation migration simulation triggers exceed the bound");
  }
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["eventId", "triggered", "conditionsSatisfied"])
      || !isBoundedText(item.eventId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventIdLength)
      || typeof item.triggered !== "boolean" || typeof item.conditionsSatisfied !== "boolean") {
      throw new TypeError("Home automation migration simulation trigger is invalid");
    }
    return Object.freeze({ eventId: item.eventId, triggered: item.triggered, conditionsSatisfied: item.conditionsSatisfied });
  }));
}

function parseExpectedActions(value: unknown): readonly HomeAutomationMigrationExpectedAction[] {
  if (!Array.isArray(value) || value.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxExpectedActions) {
    throw new TypeError("Home automation migration simulation actions exceed the bound");
  }
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || !isBoundedText(item.eventId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventIdLength)
      || !isPositiveSafeInteger(item.actionOrder) || typeof item.kind !== "string") {
      throw new TypeError("Home automation migration simulation action is invalid");
    }
    if (item.kind === "notify_local") {
      if (!hasExactKeys(item, ["eventId", "actionOrder", "kind", "message"]) || !isBoundedText(item.message, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxMessageLength)) {
        throw new TypeError("Home automation migration simulation action is invalid");
      }
      return Object.freeze({ eventId: item.eventId, actionOrder: item.actionOrder, kind: "notify_local" as const, message: item.message });
    }
    if ((item.kind !== "set_boolean" && item.kind !== "set_level")
      || !hasExactKeys(item, ["eventId", "actionOrder", "kind", "targetCapabilityId", "value"])
      || !isBoundedText(item.targetCapabilityId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength)) {
      throw new TypeError("Home automation migration simulation action is invalid");
    }
    if (item.kind === "set_boolean" && typeof item.value === "boolean") {
      return Object.freeze({ eventId: item.eventId, actionOrder: item.actionOrder, kind: "set_boolean" as const, targetCapabilityId: item.targetCapabilityId, value: item.value });
    }
    if (item.kind === "set_level" && typeof item.value === "number" && Number.isFinite(item.value) && item.value >= 0 && item.value <= 1) {
      return Object.freeze({ eventId: item.eventId, actionOrder: item.actionOrder, kind: "set_level" as const, targetCapabilityId: item.targetCapabilityId, value: item.value });
    }
    throw new TypeError("Home automation migration simulation action is invalid");
  }));
}

function parseInterference(value: unknown): readonly HomeAutomationMigrationExistingRuleInterference[] {
  if (!Array.isArray(value) || value.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxInterferenceRecords) {
    throw new TypeError("Home automation migration simulation interference exceeds the bound");
  }
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["eventId", "ruleRef", "reason", "sharedCapabilityIds", "existingActionKinds"])
      || !isBoundedText(item.eventId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventIdLength)
      || !isBoundedText(item.ruleRef, 200)
      || (item.reason !== "same_trigger" && item.reason !== "same_trigger_and_shared_target")
      || !Array.isArray(item.sharedCapabilityIds) || item.sharedCapabilityIds.length > 8
      || item.sharedCapabilityIds.some((id) => !isBoundedText(id, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength))
      || !Array.isArray(item.existingActionKinds) || item.existingActionKinds.length === 0 || item.existingActionKinds.length > 4
      || item.existingActionKinds.some((kind) => kind !== "set_boolean" && kind !== "set_level" && kind !== "notify_local")) {
      throw new TypeError("Home automation migration simulation interference is invalid");
    }
    return Object.freeze({
      eventId: item.eventId,
      ruleRef: item.ruleRef,
      reason: item.reason,
      sharedCapabilityIds: Object.freeze([...item.sharedCapabilityIds]),
      existingActionKinds: Object.freeze([...item.existingActionKinds]),
    });
  }));
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === undefined) throw new TypeError("value is not canonical JSON");
  if (seen.has(value)) throw new TypeError("value contains a cycle");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
