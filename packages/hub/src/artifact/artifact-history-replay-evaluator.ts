import {
  MAX_HISTORY_REPLAY_COUNT,
  parseHistoryReplayInput,
  type HistoryReplayEvaluation,
  type HistoryReplayInput,
  type HistoryReplayNeutralSample,
} from "./artifact-history-replay-attestation.js";
import {
  parseArtifactRevision,
  type ArtifactCondition,
  type ArtifactRevision,
} from "./neutral-artifact.js";

export const HISTORY_REPLAY_EVALUATOR = Object.freeze({
  id: "neutral-history-replay",
  version: "1.0.0",
});

/**
 * The first bounded replay evaluator is deliberately pure and clock-free.
 * It evaluates only capability_changed artifacts against imported neutral
 * samples. A schedule has no historical clock in this seam, so it remains
 * explicitly unavailable.
 */
export function evaluateHistoryReplay(
  artifact: ArtifactRevision,
  input: HistoryReplayInput,
): HistoryReplayEvaluation {
  let verifiedArtifact: ArtifactRevision;
  let parsedInput: HistoryReplayInput;
  try {
    verifiedArtifact = parseArtifactRevision(artifact);
    parsedInput = parseHistoryReplayInput(input);
  } catch {
    return unavailable();
  }

  if (!sameArtifactRef(verifiedArtifact, parsedInput)
    || verifiedArtifact.sourceProposal.proposalId !== parsedInput.proposal.id
    || verifiedArtifact.sourceProposal.proposalRevision !== parsedInput.proposal.revision
    || parsedInput.evaluator.id !== HISTORY_REPLAY_EVALUATOR.id
    || parsedInput.evaluator.version !== HISTORY_REPLAY_EVALUATOR.version) {
    return unavailable();
  }

  const joined = joinSamples(parsedInput);
  if (joined === undefined) return unavailable();
  const matchedSampleCount = joined.length;

  if (verifiedArtifact.content.trigger.kind !== "capability_changed") {
    return unavailable(matchedSampleCount);
  }

  const triggerCapabilityId = verifiedArtifact.content.trigger.source.hwCapabilityId;
  const observedCapabilities = new Set(joined.map((event) => event.capabilityId));
  if (!observedCapabilities.has(triggerCapabilityId)
    || verifiedArtifact.content.conditions.some((condition) => !observedCapabilities.has(condition.source.hwCapabilityId))) {
    return unavailable(matchedSampleCount);
  }

  const state = new Map<string, HistoryReplayNeutralSample["value"]>();
  let triggerCount = 0;
  let actionCount = 0;

  for (const event of joined) {
    const hadPrevious = state.has(event.capabilityId);
    const previous = state.get(event.capabilityId);
    state.set(event.capabilityId, event.value);

    if (event.capabilityId !== triggerCapabilityId
      || !hadPrevious
      || strictScalarEqual(previous, event.value)) {
      continue;
    }

    triggerCount += 1;
    if (triggerCount > MAX_HISTORY_REPLAY_COUNT) {
      return unavailable(matchedSampleCount, MAX_HISTORY_REPLAY_COUNT, actionCount);
    }

    const conditions = evaluateConditions(verifiedArtifact.content.conditions, state);
    if (conditions === "unavailable") {
      return unavailable(matchedSampleCount, triggerCount, actionCount);
    }
    if (conditions === "not_matched") continue;

    if (actionCount > MAX_HISTORY_REPLAY_COUNT - verifiedArtifact.content.actions.length) {
      return unavailable(matchedSampleCount, triggerCount, actionCount);
    }
    actionCount += verifiedArtifact.content.actions.length;
  }

  return {
    status: "passed",
    matchedSampleCount,
    triggerCount,
    actionCount,
    reasons: [],
  };
}

interface JoinedSample {
  readonly key: string;
  readonly capabilityId: string;
  readonly sourceTs: string;
  readonly value: HistoryReplayNeutralSample["value"];
}

function joinSamples(input: HistoryReplayInput): JoinedSample[] | undefined {
  const refsByKey = new Map<string, string>();
  for (const reference of input.refs) {
    const key = replayIdentityKey(reference.bridgeId, reference.importId, reference.historySeq);
    if (refsByKey.has(key)) return undefined;
    refsByKey.set(key, reference.capabilityId);
  }

  const seenSamples = new Set<string>();
  const joined: JoinedSample[] = [];
  for (const sample of input.samples) {
    const key = replayIdentityKey(sample.bridgeId, sample.importId, sample.historySeq);
    if (seenSamples.has(key)) return undefined;
    seenSamples.add(key);
    const capabilityId = refsByKey.get(key);
    if (capabilityId === undefined) return undefined;
    joined.push({ key, capabilityId, sourceTs: sample.sourceTs, value: sample.value });
  }

  if (joined.length !== refsByKey.size) return undefined;
  return joined.sort((left, right) => Date.parse(left.sourceTs) - Date.parse(right.sourceTs)
    || compareStrings(left.key, right.key));
}

function evaluateConditions(
  conditions: readonly ArtifactCondition[],
  state: ReadonlyMap<string, HistoryReplayNeutralSample["value"]>,
): "matched" | "not_matched" | "unavailable" {
  for (const condition of conditions) {
    if (!state.has(condition.source.hwCapabilityId)) return "unavailable";
    const current = state.get(condition.source.hwCapabilityId);
    const matched = compareCondition(condition, current);
    if (matched === "unavailable") return "unavailable";
    if (!matched) return "not_matched";
  }
  return "matched";
}

function compareCondition(
  condition: ArtifactCondition,
  current: HistoryReplayNeutralSample["value"] | undefined,
): boolean | "unavailable" {
  switch (condition.operator) {
    case "equals":
      return strictScalarEqual(current, condition.value);
    case "not_equals":
      return !strictScalarEqual(current, condition.value);
    case "greater_than":
      return numericCompare(current, condition.value, (left, right) => left > right);
    case "less_than":
      return numericCompare(current, condition.value, (left, right) => left < right);
    default:
      return "unavailable";
  }
}

function numericCompare(
  current: HistoryReplayNeutralSample["value"] | undefined,
  expected: HistoryReplayNeutralSample["value"],
  compare: (left: number, right: number) => boolean,
): boolean | "unavailable" {
  if (typeof current !== "number" || typeof expected !== "number"
    || !Number.isFinite(current) || !Number.isFinite(expected)) {
    return "unavailable";
  }
  return compare(current, expected);
}

function strictScalarEqual(
  left: HistoryReplayNeutralSample["value"] | undefined,
  right: HistoryReplayNeutralSample["value"] | undefined,
): boolean {
  return typeof left === typeof right && left === right;
}

function sameArtifactRef(artifact: ArtifactRevision, input: HistoryReplayInput): boolean {
  return artifact.artifactId === input.artifact.artifactId
    && artifact.revision === input.artifact.revision
    && artifact.contentHash === input.artifact.contentHash;
}

function replayIdentityKey(bridgeId: string, importId: string, historySeq: number): string {
  return `${bridgeId}\u0000${importId}\u0000${historySeq}`;
}

function unavailable(
  matchedSampleCount = 0,
  triggerCount = 0,
  actionCount = 0,
): HistoryReplayEvaluation {
  return {
    status: "unavailable",
    matchedSampleCount,
    triggerCount,
    actionCount,
    reasons: ["evaluator_unavailable"],
  };
}

function compareStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
