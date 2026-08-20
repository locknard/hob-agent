import {
  createArtifactCompileAttestation,
  createNeutralDiff,
  parseArtifactCompileInput,
  type ArtifactCompileAttestation,
  type ArtifactCompileInput,
  type ClosedReasonCode,
  type NeutralActionCompatibility,
  type NeutralDeviceSummary,
  type NeutralDiff,
  type NeutralPredicateCompatibility,
} from "./artifact-compiler-contract.js";
import {
  ARTIFACT_RISK_POLICY_ID,
  ARTIFACT_RISK_POLICY_VERSION,
} from "./artifact-risk-producer.js";

/**
 * The M3c compiler is deliberately a function over the already projected
 * neutral cut.  It has no bridge, credential, executor, or callback seam.
 */
export type NeutralArtifactCompiler = (input: ArtifactCompileInput) => ArtifactCompileAttestation;

export function compileNeutralArtifact(input: ArtifactCompileInput): ArtifactCompileAttestation {
  const parsed = parseArtifactCompileInput(input);
  const assessment = assessCompileInput(parsed);
  const status: ArtifactCompileAttestation["status"] = assessment.unavailable.size > 0
    ? "unavailable"
    : assessment.rejected.size > 0
      ? "rejected"
      : "compiled";
  const diff = status === "compiled" ? buildDiff(parsed) : unavailableDiff();
  const blockingReasons = status === "unavailable"
    ? [...new Set([...assessment.unavailable, ...assessment.rejected])]
    : status === "rejected"
      ? [...assessment.rejected]
      : [];

  return createArtifactCompileAttestation({
    input: parsed,
    status,
    ...(status === "compiled" ? { plan: parsed.artifact.content } : {}),
    diff,
    conflicts: parsed.currentConflict.result,
    blockingReasons,
  });
}

export const neutralArtifactCompiler: NeutralArtifactCompiler = compileNeutralArtifact;

interface CompileAssessment {
  readonly unavailable: Set<ClosedReasonCode>;
  readonly rejected: Set<ClosedReasonCode>;
}

function assessCompileInput(input: ArtifactCompileInput): CompileAssessment {
  const unavailable = new Set<ClosedReasonCode>();
  const rejected = new Set<ClosedReasonCode>();
  const addUnavailable = (reason: ClosedReasonCode): void => { unavailable.add(reason); };
  const addRejected = (reason: ClosedReasonCode): void => { rejected.add(reason); };

  assessProposal(input, addUnavailable, addRejected);
  assessEvidence(input, addUnavailable);
  assessWatermarks(input, addUnavailable);
  assessRisk(input, addRejected);
  assessAuthority(input, addUnavailable);
  assessConflictCuts(input, addUnavailable);
  assessDeviceValidity(input, addUnavailable, addRejected);
  assessTriggerRead(input, addUnavailable, addRejected);
  assessPredicates(input, addUnavailable, addRejected);
  assessActions(input, addUnavailable, addRejected);

  return { unavailable, rejected };
}

function assessProposal(
  input: ArtifactCompileInput,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  if (input.proposal.status === "pending_review") {
    addUnavailable("not_ready");
  } else if (input.proposal.status === "rejected" || input.proposal.status === "expired") {
    addRejected("policy_blocked");
  }
}

function assessEvidence(input: ArtifactCompileInput, addUnavailable: (reason: ClosedReasonCode) => void): void {
  if (input.evidence.coverage !== "complete") addUnavailable("evidence_unavailable");
}

function assessWatermarks(input: ArtifactCompileInput, addUnavailable: (reason: ClosedReasonCode) => void): void {
  const watermarks = [
    ...input.evidence.watermarks,
    ...input.authority.checkedWatermarks,
    ...input.worldCut.watermarks,
  ];
  if (watermarks.some((watermark) => watermark.freshness !== "fresh" || watermark.gapCount !== 0)) {
    addUnavailable("watermark_stale");
  }
}

function assessRisk(input: ArtifactCompileInput, addRejected: (reason: ClosedReasonCode) => void): void {
  const hasDeviceAction = input.artifact.content.actions.some((action) => action.kind !== "notify_local");
  const expectedClass = hasDeviceAction ? "comfort_reversible" : "observe_or_notify";
  if (input.risk.class !== expectedClass) addRejected("policy_blocked");
  if (input.risk.policyId !== ARTIFACT_RISK_POLICY_ID
    || input.risk.policyVersion !== ARTIFACT_RISK_POLICY_VERSION) {
    addRejected("policy_blocked");
  }
}

function assessAuthority(input: ArtifactCompileInput, addUnavailable: (reason: ClosedReasonCode) => void): void {
  for (const action of input.artifact.content.actions) {
    if (action.kind === "notify_local") continue;
    const available = input.authority.candidates.filter((candidate) =>
      candidate.hwCapabilityId === action.target.hwCapabilityId && candidate.status === "available",
    );
    if (available.length !== 1) addUnavailable("authority_unavailable");
  }
}

function assessConflictCuts(input: ArtifactCompileInput, addUnavailable: (reason: ClosedReasonCode) => void): void {
  if (input.currentConflict.result.status === "unavailable") addUnavailable("foreign_catalog_unavailable");
  for (const check of input.foreignRuleChecks) {
    if (check.status === "unavailable") addUnavailable("foreign_catalog_unavailable");
    if (check.watermark.freshness !== "fresh" || check.watermark.gapCount !== 0) {
      addUnavailable("foreign_catalog_stale");
    }
  }
}

function assessDeviceValidity(
  input: ArtifactCompileInput,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  for (const device of input.worldCut.devices) {
    switch (device.validity) {
      case "valid":
        break;
      case "stale":
        addUnavailable("state_stale");
        break;
      case "invalid-source":
      case "unavailable":
        addUnavailable("target_unavailable");
        break;
      case "invalid":
      case "present-but-invalid":
        addRejected("target_invalid");
        break;
    }
  }
}

function assessTriggerRead(
  input: ArtifactCompileInput,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  const trigger = input.artifact.content.trigger;
  if (trigger.kind !== "capability_changed") return;
  const device = deviceFor(input, trigger.source.hwCapabilityId);
  if (device === undefined) {
    addUnavailable("world_cut_unavailable");
    return;
  }
  const read = device.read;
  if (read.status === "available") return;
  if (read.status === "unsupported") addRejected(read.reason);
  if (read.status === "unavailable") addUnavailable(read.reason);
}

function assessPredicates(
  input: ArtifactCompileInput,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  for (const [index, predicate] of input.artifact.content.conditions.entries()) {
    assessPredicateProjection(input, predicate.source.hwCapabilityId, "condition", index + 1, addUnavailable, addRejected);
  }
  for (const [index, predicate] of input.artifact.content.postconditions.entries()) {
    assessPredicateProjection(input, predicate.source.hwCapabilityId, "postcondition", index + 1, addUnavailable, addRejected);
  }
}

function assessPredicateProjection(
  input: ArtifactCompileInput,
  hwCapabilityId: string,
  phase: NeutralPredicateCompatibility["phase"],
  order: number,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  const device = deviceFor(input, hwCapabilityId);
  const projection = device?.predicateCompatibility.find((candidate) => candidate.phase === phase && candidate.order === order);
  if (projection === undefined) {
    addUnavailable("world_cut_unavailable");
    return;
  }
  if (projection.status === "unavailable") addUnavailable(projection.reason ?? "world_cut_unavailable");
  if (projection.status === "incompatible") addRejected(projection.reason ?? "semantic_mismatch");
}

function assessActions(
  input: ArtifactCompileInput,
  addUnavailable: (reason: ClosedReasonCode) => void,
  addRejected: (reason: ClosedReasonCode) => void,
): void {
  for (const [index, action] of input.artifact.content.actions.entries()) {
    if (action.kind === "notify_local") continue;
    const device = deviceFor(input, action.target.hwCapabilityId);
    const projection = device?.actionCompatibility.find((candidate) => candidate.order === index + 1);
    if (projection === undefined) {
      addUnavailable("world_cut_unavailable");
      continue;
    }
    if (projection.status === "unavailable") addUnavailable(projection.reason ?? "world_cut_unavailable");
    if (projection.status === "incompatible") addRejected(projection.reason ?? "action_invalid");
  }
}

function buildDiff(input: ArtifactCompileInput): NeutralDiff {
  const operations: Array<{
    readonly actionOrder: number;
    readonly kind: "set_level" | "set_boolean" | "notify_local";
    readonly hwCapabilityId?: string;
    readonly actionAuthorityCandidateId?: string;
    readonly before?: string | number | boolean | null;
    readonly after?: string | number | boolean | null;
  }> = [];
  let unchangedCount = 0;

  for (const [index, action] of input.artifact.content.actions.entries()) {
    const actionOrder = index + 1;
    if (action.kind === "notify_local") {
      operations.push({ actionOrder, kind: "notify_local", after: action.message });
      continue;
    }
    const device = deviceFor(input, action.target.hwCapabilityId);
    const projection = device?.actionCompatibility.find((candidate) => candidate.order === actionOrder);
    const candidate = input.authority.candidates.find((item) =>
      item.hwCapabilityId === action.target.hwCapabilityId && item.status === "available",
    );
    if (projection === undefined || projection.status !== "compatible" || candidate === undefined) {
      return unavailableDiff();
    }
    if (sameScalar(projection.before, projection.after)) {
      unchangedCount += 1;
      continue;
    }
    operations.push({
      actionOrder,
      kind: action.kind,
      hwCapabilityId: action.target.hwCapabilityId,
      actionAuthorityCandidateId: candidate.actionAuthorityCandidateId,
      before: projection.before,
      after: projection.after,
    });
  }

  return createNeutralDiff({
    status: operations.length === 0 ? "no_change" : "changes",
    operations,
    unchangedCount,
    redacted: true,
  });
}

function unavailableDiff(): NeutralDiff {
  return createNeutralDiff({ status: "unavailable", operations: [], unchangedCount: 0, redacted: true });
}

function deviceFor(input: ArtifactCompileInput, hwCapabilityId: string): NeutralDeviceSummary | undefined {
  return input.worldCut.devices.find((device) => device.hwCapabilityId === hwCapabilityId);
}

function sameScalar(left: NeutralActionCompatibility["before"], right: NeutralActionCompatibility["after"]): boolean {
  return left === right;
}
