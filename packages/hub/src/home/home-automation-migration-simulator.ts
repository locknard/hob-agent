import { createHash } from "node:crypto";

import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import { parseArtifactContent, type ArtifactContent } from "../artifact/neutral-artifact.js";
import {
  HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS,
  computeHomeAutomationMigrationSimulationDigest,
  type HomeAutomationMigrationDualRunInput,
  type HomeAutomationMigrationDualRunResult,
  type HomeAutomationMigrationExistingRuleAction,
  type HomeAutomationMigrationExistingRuleInterference,
  type HomeAutomationMigrationExistingRuleSummary,
  type HomeAutomationMigrationExpectedAction,
  type HomeAutomationMigrationExpectedTrigger,
  type HomeAutomationMigrationSimulationEvent,
  type HomeAutomationMigrationSimulationPreparation,
  type HomeAutomationMigrationSimulationReason as HomeAutomationMigrationDualRunReason,
  type HomeAutomationMigrationSimulationScalar,
  type HomeAutomationMigrationSimulationSourceCut,
  type HomeAutomationMigrationSimulationValue,
  type HomeAutomationMigrationSimulationReceipt,
  parseHomeAutomationMigrationSimulationReceipt,
} from "./home-automation-migration-simulation.js";

/** The narrow immutable input accepted by the migration projection. */
export interface HomeAutomationMigrationSimulatorInput {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  /** A candidate returned by the bounded foreign-rule adapter. */
  readonly candidate: unknown;
  /** A HomeProposalService ProposalEnvelope or its equivalent read-only view. */
  readonly proposal: unknown;
  /** The HomeProposalService preparationForProposal projection, when present. */
  readonly preparation?: unknown;
}

export type HomeAutomationMigrationSimulationReason =
  | "invalid_candidate"
  | "proposal_unavailable"
  | "candidate_mismatch"
  | "rule_binding_mismatch"
  | "source_fingerprint_mismatch"
  | "proposal_mismatch"
  | "preparation_unavailable"
  | "preparation_failed"
  | "prepared_artifact_missing"
  | "preparation_not_succeeded"
  | "prepared_content_stale";

export type HomeAutomationMigrationSimulationResult =
  | {
    readonly status: "translated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "simulated";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly candidateContentHash: string;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "ready";
    readonly ruleRef: string;
    readonly sourceFingerprint: string;
    readonly proposalId: string;
    readonly candidateProposalRevision: number;
    readonly reviewProposalRevision: number;
    readonly candidateContentHash: string;
    readonly preparedArtifact: HomeAutomationMigrationPreparedArtifact;
    readonly writesPerformed: false;
  }
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationSimulationReason;
    readonly writesPerformed: false;
  };

export interface HomeAutomationMigrationPreparedArtifact {
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
}

/**
 * Projects an imported rule into the existing proposal/preparation lifecycle.
 * This function deliberately has no compiler, registry, bridge, or write
 * dependency: compiler and dry-run attestations are produced by the governed
 * preparation worker and arrive here only through durable references.
 */
export function projectHomeAutomationMigration(
  input: HomeAutomationMigrationSimulatorInput,
): HomeAutomationMigrationSimulationResult {
  try {
    const parsedInput = parseInput(input);
    if (parsedInput === undefined) return needs("preparation_unavailable");

    const candidate = parseCandidate(parsedInput.candidate);
    if (candidate === undefined) return needs("invalid_candidate");
    const proposal = parseProposal(parsedInput.proposal);
    if (proposal === undefined) return needs("proposal_unavailable");

    if (candidate.ruleRef !== parsedInput.ruleRef) return needs("rule_binding_mismatch");
    if (candidate.sourceFingerprint !== parsedInput.sourceFingerprint) {
      return needs("source_fingerprint_mismatch");
    }
    if (candidate.title !== proposal.title
      || candidate.contentHash !== proposal.candidateContentHash) {
      return needs("candidate_mismatch");
    }

    const preparation = parsePreparation(parsedInput.preparation);
    if (parsedInput.preparation !== undefined && preparation === undefined) {
      return needs("preparation_unavailable");
    }
    if (preparation === undefined) {
      return proposal.lifecycle === "ready"
        ? needs("preparation_not_succeeded")
        : translated(candidate, proposal, proposal.revision);
    }
    if (preparation.proposalId !== proposal.id
      || !preparationRevisionMatchesProposal(preparation, proposal)) {
      return needs("proposal_mismatch");
    }
    if (preparation.status === "failed") return needs("preparation_failed");
    if (preparation.status === "queued" || preparation.status === "running") {
      return proposal.lifecycle === "ready"
        ? needs("preparation_not_succeeded")
        : translated(candidate, proposal, preparation.proposalRevision);
    }

    const preparedArtifact = parsePreparedArtifact(proposal.preparedArtifact);
    if (proposal.lifecycle !== "ready") {
      return proposal.preparedArtifact === undefined
        ? simulated(candidate, proposal, preparation.proposalRevision)
        : needs("proposal_mismatch");
    }
    if (preparedArtifact === undefined) return needs("prepared_artifact_missing");
    if (!proposal.preparedContentHash || !proposal.preparedContentHashMatches) {
      return needs("prepared_content_stale");
    }
    return ready(candidate, preparation.proposalRevision, proposal, preparedArtifact);
  } catch {
    return needs("preparation_unavailable");
  }
}

/** A class facade keeps the projection easy to mount from a runtime service. */
export class HomeAutomationMigrationSimulator {
  project(input: HomeAutomationMigrationSimulatorInput): HomeAutomationMigrationSimulationResult {
    return projectHomeAutomationMigration(input);
  }

  simulate(input: HomeAutomationMigrationDualRunInput): HomeAutomationMigrationDualRunResult {
    return simulateHomeAutomationMigrationDualRun(input);
  }
}

export const simulateHomeAutomationMigration = projectHomeAutomationMigration;

/** Computes the stable neutral content identity used to bind a candidate. */
export function computeHomeAutomationMigrationCandidateContentHash(content: unknown): string {
  const parsed = parseArtifactContent(content);
  return digestCanonical(parsed);
}

/**
 * Runs one bounded, neutral dual-run over supplied event samples. The old
 * rules are represented only by summaries; no provider payload, bridge, or
 * write-capable dependency can enter this function.
 */
export function simulateHomeAutomationMigrationDualRun(
  input: HomeAutomationMigrationDualRunInput,
): HomeAutomationMigrationDualRunResult {
  try {
    if (!isRecord(input) || !hasExactKeys(input, ["sourceCut", "candidate", "preparation", "eventSamples", "existingRuleSummaries"])) {
      return dualRunNeeds("invalid_input");
    }
    const sourceCut = parseSimulationSourceCut(input.sourceCut);
    if (sourceCut === undefined) return dualRunNeeds("invalid_input");
    const candidate = parseDualRunCandidate(input.candidate);
    if (candidate === undefined) return dualRunNeeds("unsupported");
    const preparation = parseDualRunPreparation(input.preparation);
    if (preparation === undefined) return dualRunNeeds("invalid_input");
    if (candidate.sourceFingerprint !== sourceCut.configFingerprint) return dualRunNeeds("stale");

    const eventSamples = parseSimulationEvents(input.eventSamples);
    if (eventSamples === undefined) return dualRunNeeds("invalid_input");
    if (eventSamples.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventSamples) {
      return dualRunNeeds("over_limit");
    }
    const existingRuleSummaries = parseExistingRuleSummaries(input.existingRuleSummaries);
    if (existingRuleSummaries === undefined) return dualRunNeeds("invalid_input");
    if (existingRuleSummaries.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxExistingRuleSummaries) {
      return dualRunNeeds("over_limit");
    }

    const expectedTriggers: HomeAutomationMigrationExpectedTrigger[] = [];
    const expectedActions: HomeAutomationMigrationExpectedAction[] = [];
    const existingRuleInterference: HomeAutomationMigrationExistingRuleInterference[] = [];
    const deviceTargetIds = candidate.content.actions.flatMap((action) => action.kind === "notify_local" ? [] : [action.target.hwCapabilityId]);

    for (const event of eventSamples) {
      const triggered = eventMatchesTrigger(candidate.content.trigger, event);
      const conditions = evaluateConditions(candidate.content.conditions, event);
      if (conditions === "ambiguous") return dualRunNeeds("ambiguous");
      const shouldRun = triggered && conditions === true;
      expectedTriggers.push(Object.freeze({
        eventId: event.eventId,
        triggered,
        conditionsSatisfied: conditions,
      }));
      if (shouldRun) {
        candidate.content.actions.forEach((action, index) => {
          expectedActions.push(expectedAction(event.eventId, index + 1, action));
        });
      }

      for (const existing of existingRuleSummaries) {
        if (!shouldRun || !existing.enabled || !existingRuleMatchesTrigger(existing.trigger, event)) continue;
        const sharedCapabilityIds = [...new Set(existing.actions.flatMap((action) => action.kind === "notify_local" ? [] : [action.targetCapabilityId]))]
          .filter((capabilityId) => deviceTargetIds.includes(capabilityId));
        existingRuleInterference.push(Object.freeze({
          eventId: event.eventId,
          ruleRef: existing.ruleRef,
          reason: sharedCapabilityIds.length > 0 ? "same_trigger_and_shared_target" as const : "same_trigger" as const,
          sharedCapabilityIds: Object.freeze(sharedCapabilityIds),
          existingActionKinds: Object.freeze(existing.actions.map((action) => action.kind)),
        }));
      }
    }

    if (expectedActions.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxExpectedActions
      || existingRuleInterference.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxInterferenceRecords) {
      return dualRunNeeds("over_limit");
    }
    const candidateContentHash = digestCanonical(candidate.content);
    const unsignedReceipt = {
      schemaVersion: "1" as const,
      kind: "home-automation-migration-simulation" as const,
      sourceCut,
      sourceFingerprint: candidate.sourceFingerprint,
      candidateContentHash,
      preparation,
      expectedTriggers: Object.freeze(expectedTriggers),
      expectedActions: Object.freeze(expectedActions),
      existingRuleInterference: Object.freeze(existingRuleInterference),
      simulationDigest: `sha256:${"0".repeat(64)}`,
      writesPerformed: false as const,
    };
    const receipt = parseHomeAutomationMigrationSimulationReceipt({
      ...unsignedReceipt,
      simulationDigest: computeHomeAutomationMigrationSimulationDigest(unsignedReceipt),
    });
    return Object.freeze({ status: "simulated" as const, receipt, writesPerformed: false as const });
  } catch {
    return dualRunNeeds("invalid_input");
  }
}

function parseDualRunPreparation(value: unknown): HomeAutomationMigrationSimulationPreparation | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId",
  ]) || !isBoundedId(value.artifactId, 200)
    || !isPositiveSafeInteger(value.artifactRevision)
    || !isDigest(value.artifactContentHash)
    || !isDigest(value.compileResultId)
    || !isDigest(value.dryRunResultId)) return undefined;
  return Object.freeze({
    artifactId: value.artifactId,
    artifactRevision: value.artifactRevision,
    artifactContentHash: value.artifactContentHash,
    compileResultId: value.compileResultId,
    dryRunResultId: value.dryRunResultId,
  });
}

function parseSimulationSourceCut(value: unknown): HomeAutomationMigrationSimulationSourceCut | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["bridgeId", "epochId", "lastSeq", "configFingerprint"])
    || !isBoundedId(value.bridgeId, 200)
    || !isBoundedId(value.epochId, 256)
    || !isPositiveSafeInteger(value.lastSeq)
    || !isDigest(value.configFingerprint)) return undefined;
  return Object.freeze({
    bridgeId: value.bridgeId,
    epochId: value.epochId,
    lastSeq: value.lastSeq,
    configFingerprint: value.configFingerprint,
  });
}

function parseDualRunCandidate(value: unknown): ForeignRuleArtifactCandidate | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "sourceFingerprint", "ruleRef", "title", "content"])
    || value.status !== "candidate"
    || !isDigest(value.sourceFingerprint)
    || !isBoundedId(value.ruleRef, 200)
    || !isBoundedText(value.title, 120)) return undefined;
  let content: ArtifactContent;
  try { content = parseArtifactContent(value.content); } catch { return undefined; }
  const deviceTargetIds = content.actions.flatMap((action) => action.kind === "notify_local" ? [] : [action.target.hwCapabilityId]);
  if (content.conditions.length > 8 || content.actions.length > 4 || new Set(deviceTargetIds).size > 1) return undefined;
  return Object.freeze({
    status: "candidate" as const,
    sourceFingerprint: value.sourceFingerprint,
    ruleRef: value.ruleRef,
    title: value.title,
    content,
  });
}

function parseSimulationEvents(value: unknown): readonly HomeAutomationMigrationSimulationEvent[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventSamples) return value as never;
  const ids = new Set<string>();
  const events = value.map((item) => {
    if (!isRecord(item) || !isBoundedId(item.eventId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxEventIdLength)
      || ids.has(item.eventId) || !isIsoTimestamp(item.occurredAt) || !Array.isArray(item.values)
      || item.values.length > HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxValuesPerEvent) return undefined;
    ids.add(item.eventId);
    const values = parseSimulationValues(item.values);
    if (values === undefined) return undefined;
    if (item.kind === "capability_changed") {
      return !hasExactKeys(item, ["eventId", "kind", "occurredAt", "capabilityId", "values"])
        || !isBoundedId(item.capabilityId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength)
        ? undefined
        : Object.freeze({ eventId: item.eventId, kind: "capability_changed" as const, occurredAt: item.occurredAt, capabilityId: item.capabilityId, values });
    }
    if (item.kind === "schedule") {
      return !hasExactKeys(item, ["eventId", "kind", "occurredAt", "timezone", "daysOfWeek", "at", "values"])
        || !isBoundedId(item.timezone, 128)
        || !isScheduleDays(item.daysOfWeek)
        || !isScheduleTime(item.at)
        ? undefined
        : Object.freeze({ eventId: item.eventId, kind: "schedule" as const, occurredAt: item.occurredAt, timezone: item.timezone, daysOfWeek: Object.freeze([...item.daysOfWeek]), at: item.at, values });
    }
    return undefined;
  });
  return events.some((event) => event === undefined) ? undefined : Object.freeze(events as HomeAutomationMigrationSimulationEvent[]);
}

function parseSimulationValues(value: unknown): readonly HomeAutomationMigrationSimulationValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const values = value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["capabilityId", "value"])
      || !isBoundedId(item.capabilityId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength)
      || ids.has(item.capabilityId) || !isScalar(item.value)) return undefined;
    ids.add(item.capabilityId);
    return Object.freeze({ capabilityId: item.capabilityId, value: item.value });
  });
  return values.some((item) => item === undefined) ? undefined : Object.freeze(values as HomeAutomationMigrationSimulationValue[]);
}

function parseExistingRuleSummaries(value: unknown): readonly HomeAutomationMigrationExistingRuleSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = new Set<string>();
  const summaries = value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["ruleRef", "enabled", "trigger", "actions"])
      || !isBoundedId(item.ruleRef, 200) || refs.has(item.ruleRef) || typeof item.enabled !== "boolean"
      || !Array.isArray(item.actions) || item.actions.length === 0 || item.actions.length > 4) return undefined;
    refs.add(item.ruleRef);
    const trigger = parseExistingTrigger(item.trigger);
    const actions = parseExistingActions(item.actions);
    if (trigger === undefined || actions === undefined) return undefined;
    return Object.freeze({ ruleRef: item.ruleRef, enabled: item.enabled, trigger, actions });
  });
  return summaries.some((item) => item === undefined) ? undefined : Object.freeze(summaries as HomeAutomationMigrationExistingRuleSummary[]);
}

function parseExistingTrigger(value: unknown): HomeAutomationMigrationExistingRuleSummary["trigger"] | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "capability_changed") {
    return hasExactKeys(value, ["kind", "sourceCapabilityId"]) && isBoundedId(value.sourceCapabilityId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength)
      ? Object.freeze({ kind: "capability_changed" as const, sourceCapabilityId: value.sourceCapabilityId })
      : undefined;
  }
  if (value.kind === "schedule") {
    return hasExactKeys(value, ["kind", "timezone", "daysOfWeek", "at"])
      && isBoundedId(value.timezone, 128) && isScheduleDays(value.daysOfWeek) && isScheduleTime(value.at)
      ? Object.freeze({ kind: "schedule" as const, timezone: value.timezone, daysOfWeek: Object.freeze([...value.daysOfWeek]), at: value.at })
      : undefined;
  }
  return undefined;
}

function parseExistingActions(value: readonly unknown[]): readonly HomeAutomationMigrationExistingRuleAction[] | undefined {
  const actions = value.map((item) => {
    if (!isRecord(item) || typeof item.kind !== "string") return undefined;
    if (item.kind === "notify_local") {
      return hasExactKeys(item, ["kind", "message"]) && isBoundedText(item.message, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxMessageLength)
        ? Object.freeze({ kind: "notify_local" as const, message: item.message })
        : undefined;
    }
    if ((item.kind !== "set_boolean" && item.kind !== "set_level")
      || !hasExactKeys(item, ["kind", "targetCapabilityId", "value"])
      || !isBoundedId(item.targetCapabilityId, HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxCapabilityIdLength)) return undefined;
    if (item.kind === "set_boolean" && typeof item.value === "boolean") {
      return Object.freeze({ kind: "set_boolean" as const, targetCapabilityId: item.targetCapabilityId, value: item.value });
    }
    if (item.kind === "set_level" && typeof item.value === "number" && Number.isFinite(item.value) && item.value >= 0 && item.value <= 1) {
      return Object.freeze({ kind: "set_level" as const, targetCapabilityId: item.targetCapabilityId, value: item.value });
    }
    return undefined;
  });
  return actions.some((item) => item === undefined) ? undefined : Object.freeze(actions as HomeAutomationMigrationExistingRuleAction[]);
}

function eventMatchesTrigger(
  trigger: ArtifactContent["trigger"],
  event: HomeAutomationMigrationSimulationEvent,
): boolean {
  if (trigger.kind === "capability_changed") {
    return event.kind === "capability_changed" && trigger.source.hwCapabilityId === event.capabilityId;
  }
  return event.kind === "schedule"
    && trigger.timezone === event.timezone
    && trigger.at === event.at
    && sameNumberArray(trigger.daysOfWeek, event.daysOfWeek);
}

function existingRuleMatchesTrigger(
  trigger: HomeAutomationMigrationExistingRuleSummary["trigger"],
  event: HomeAutomationMigrationSimulationEvent,
): boolean {
  if (trigger.kind === "capability_changed") {
    return event.kind === "capability_changed" && trigger.sourceCapabilityId === event.capabilityId;
  }
  return event.kind === "schedule"
    && trigger.timezone === event.timezone
    && trigger.at === event.at
    && sameNumberArray(trigger.daysOfWeek, event.daysOfWeek);
}

function evaluateConditions(
  conditions: ArtifactContent["conditions"],
  event: HomeAutomationMigrationSimulationEvent,
): true | false | "ambiguous" {
  for (const condition of conditions) {
    const observed = event.values.find((value) => value.capabilityId === condition.source.hwCapabilityId);
    if (observed === undefined) return "ambiguous";
    if (!compareCondition(condition.operator, observed.value, condition.value)) return false;
  }
  return true;
}

function compareCondition(
  operator: "equals" | "not_equals" | "greater_than" | "less_than",
  observed: HomeAutomationMigrationSimulationScalar,
  expected: HomeAutomationMigrationSimulationScalar,
): boolean {
  if (operator === "equals") return observed === expected;
  if (operator === "not_equals") return observed !== expected;
  if (typeof observed !== "number" || typeof expected !== "number") return false;
  return operator === "greater_than" ? observed > expected : observed < expected;
}

function expectedAction(
  eventId: string,
  actionOrder: number,
  action: ArtifactContent["actions"][number],
): HomeAutomationMigrationExpectedAction {
  if (action.kind === "notify_local") return Object.freeze({ eventId, actionOrder, kind: "notify_local" as const, message: action.message });
  if (action.kind === "set_boolean") return Object.freeze({ eventId, actionOrder, kind: "set_boolean" as const, targetCapabilityId: action.target.hwCapabilityId, value: action.value });
  return Object.freeze({ eventId, actionOrder, kind: "set_level" as const, targetCapabilityId: action.target.hwCapabilityId, value: action.value });
}

function dualRunNeeds(reason: HomeAutomationMigrationDualRunReason): HomeAutomationMigrationDualRunResult {
  return Object.freeze({ status: "needs_attention" as const, reason, writesPerformed: false as const });
}

interface ParsedInput {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  readonly candidate: unknown;
  readonly proposal: unknown;
  readonly preparation?: unknown;
}

interface ParsedCandidate {
  readonly ruleRef: string;
  readonly sourceFingerprint: string;
  readonly title: string;
  readonly content: ArtifactContent;
  readonly contentHash: string;
}

interface ParsedProposal {
  readonly id: string;
  readonly revision: number;
  readonly lifecycle: "preparing" | "needs_info" | "ready";
  readonly title: string;
  readonly candidateContentHash: string;
  readonly preparedArtifact?: unknown;
  readonly preparedContentHash?: string;
  readonly preparedContentHashMatches: boolean;
}

interface ParsedPreparation {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly status: "queued" | "running" | "succeeded" | "failed";
}

function parseInput(value: unknown): ParsedInput | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["ruleRef", "sourceFingerprint", "candidate", "proposal", "preparation"])) {
      // The optional preparation key is omitted by normal callers. Accept
      // both exact forms while rejecting arbitrary caller-controlled fields.
      if (!isRecord(value) || !hasExactKeys(value, ["ruleRef", "sourceFingerprint", "candidate", "proposal"])) return undefined;
    }
    if (!isBoundedId(value.ruleRef, 200) || !isDigest(value.sourceFingerprint)) return undefined;
    return {
      ruleRef: value.ruleRef,
      sourceFingerprint: value.sourceFingerprint,
      candidate: value.candidate,
      proposal: value.proposal,
      ...(Object.hasOwn(value, "preparation") ? { preparation: value.preparation } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseCandidate(value: unknown): ParsedCandidate | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["status", "ruleRef", "sourceFingerprint", "title", "content"])
      || value.status !== "candidate"
      || !isBoundedId(value.ruleRef, 200)
      || !isDigest(value.sourceFingerprint)
      || !isBoundedText(value.title, 120)) return undefined;
    const content = parseArtifactContent(value.content);
    return {
      ruleRef: value.ruleRef,
      sourceFingerprint: value.sourceFingerprint,
      title: value.title,
      content,
      contentHash: digestCanonical(content),
    };
  } catch {
    return undefined;
  }
}

function parseProposal(value: unknown): ParsedProposal | undefined {
  try {
    if (!isRecord(value)
      || value.kind !== "automation-draft"
      || value.status !== "pending_review"
      || !isBoundedId(value.id, 200)
      || !isPositiveSafeInteger(value.revision)
      || (value.lifecycle !== "preparing" && value.lifecycle !== "needs_info" && value.lifecycle !== "ready")
      || !isBoundedText(value.title, 120)
      || !isRecord(value.artifactCandidate)
      || !hasExactKeys(value.artifactCandidate, ["schemaVersion", "content"])
      || value.artifactCandidate.schemaVersion !== "1") return undefined;
    const proposalContent = parseArtifactContent(value.artifactCandidate.content);
    const candidateContentHash = digestCanonical(proposalContent);
    const preparedContentHash = value.preparedContentHash;
    if (preparedContentHash !== undefined && !isDigest(preparedContentHash)) return undefined;
    const preparedContentHashMatches = preparedContentHash === undefined
      ? false
      : preparedContentHash === computePreparedContentHash(value);
    return {
      id: value.id,
      revision: value.revision,
      lifecycle: value.lifecycle,
      title: value.title,
      candidateContentHash,
      ...(Object.hasOwn(value, "preparedArtifact") ? { preparedArtifact: value.preparedArtifact } : {}),
      ...(preparedContentHash === undefined ? {} : { preparedContentHash }),
      preparedContentHashMatches,
    };
  } catch {
    return undefined;
  }
}

function parsePreparation(value: unknown): ParsedPreparation | undefined {
  if (value === undefined) return undefined;
  try {
    if (!isRecord(value)
      || !isBoundedId(value.proposalId, 200)
      || !isPositiveSafeInteger(value.proposalRevision)
      || (value.status !== "queued" && value.status !== "running" && value.status !== "succeeded" && value.status !== "failed")) {
      return undefined;
    }
    return {
      proposalId: value.proposalId,
      proposalRevision: value.proposalRevision,
      status: value.status,
    };
  } catch {
    return undefined;
  }
}

function parsePreparedArtifact(value: unknown): HomeAutomationMigrationPreparedArtifact | undefined {
  try {
    if (!isRecord(value)
      || !hasExactKeys(value, ["artifactId", "revision", "contentHash", "compileResultId", "dryRunResultId"])
      || !isBoundedId(value.artifactId, 256)
      || !isPositiveSafeInteger(value.revision)
      || !isDigest(value.contentHash)
      || !isDigest(value.compileResultId)
      || !isDigest(value.dryRunResultId)) return undefined;
    return Object.freeze({
      artifactId: value.artifactId,
      revision: value.revision,
      contentHash: value.contentHash,
      compileResultId: value.compileResultId,
      dryRunResultId: value.dryRunResultId,
    });
  } catch {
    return undefined;
  }
}

function preparationRevisionMatchesProposal(
  preparation: ParsedPreparation,
  proposal: ParsedProposal,
): boolean {
  if (proposal.lifecycle === "ready") {
    return preparation.proposalRevision < Number.MAX_SAFE_INTEGER
      && preparation.proposalRevision + 1 === proposal.revision;
  }
  return preparation.proposalRevision === proposal.revision;
}

function translated(
  candidate: ParsedCandidate,
  proposal: ParsedProposal,
  candidateProposalRevision: number,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "translated" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    candidateContentHash: candidate.contentHash,
    writesPerformed: false as const,
  });
}

function simulated(
  candidate: ParsedCandidate,
  proposal: ParsedProposal,
  candidateProposalRevision: number,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "simulated" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    candidateContentHash: candidate.contentHash,
    writesPerformed: false as const,
  });
}

function ready(
  candidate: ParsedCandidate,
  candidateProposalRevision: number,
  proposal: ParsedProposal,
  preparedArtifact: HomeAutomationMigrationPreparedArtifact,
): HomeAutomationMigrationSimulationResult {
  return Object.freeze({
    status: "ready" as const,
    ruleRef: candidate.ruleRef,
    sourceFingerprint: candidate.sourceFingerprint,
    proposalId: proposal.id,
    candidateProposalRevision,
    reviewProposalRevision: proposal.revision,
    candidateContentHash: candidate.contentHash,
    preparedArtifact,
    writesPerformed: false as const,
  });
}

function needs(reason: HomeAutomationMigrationSimulationReason): HomeAutomationMigrationSimulationResult {
  return Object.freeze({ status: "needs_attention" as const, reason, writesPerformed: false as const });
}

function computePreparedContentHash(value: Record<string, unknown>): string {
  const snapshot = {
    title: value.title,
    summary: value.summary,
    intent: value.intent,
    rationale: value.rationale ?? null,
    artifactCandidate: value.artifactCandidate ?? null,
    risk: value.risk,
    actionPolicyClasses: value.actionPolicyClasses ?? null,
    confirmationDeviceNames: value.confirmationDeviceNames ?? null,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new TypeError("value is not canonical JSON");
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

function isBoundedId(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxBytes
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isBoundedId(value, maxBytes) && !/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isScheduleDays(value: unknown): value is readonly number[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 7
    && value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6)
    && new Set(value).size === value.length;
}

function isScheduleTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isScalar(value: unknown): value is HomeAutomationMigrationSimulationScalar {
  return value === null
    || typeof value === "string" && Buffer.byteLength(value, "utf8") <= HOME_AUTOMATION_MIGRATION_SIMULATION_LIMITS.maxScalarStringBytes
    || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value);
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
