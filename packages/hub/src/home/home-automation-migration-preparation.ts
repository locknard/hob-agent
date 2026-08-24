import { createHash } from "node:crypto";

import type { ForeignRuleArtifactCandidate } from "../artifact/foreign-rule-artifact-candidate.js";
import { parseArtifactContent, type ArtifactContent } from "../artifact/neutral-artifact.js";
import type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationRuleAssessment,
} from "./home-automation-migration.js";
import type {
  HomeAutomationMigrationRuntimeCandidateResult,
} from "./home-automation-migration-runtime-service.js";
import type { CreateHomeMigrationDraftInput } from "./home-proposal-service.js";
import type {
  ProposalCreationResult,
  ProposalEnvelope,
} from "./proposal-store.js";

/**
 * The only migration source this adapter accepts. The concrete runtime owns
 * the assessment store and re-translates the exact source cut before it
 * returns a candidate; callers provide identities, never candidate content.
 */
export interface HomeAutomationMigrationPreparationCandidateSource {
  get(migrationId: string): HomeAutomationMigrationAssessment | undefined;
  createArtifactCandidate(
    input: { readonly migrationId: string; readonly ruleRef: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<HomeAutomationMigrationRuntimeCandidateResult> | HomeAutomationMigrationRuntimeCandidateResult;
}

/** The world read seam used only to derive the candidate's device scope. */
export interface HomeAutomationMigrationPreparationWorldPort {
  snapshot(): {
    readonly devices: readonly {
      readonly hwId: string;
      readonly validity: "valid" | "stale" | "invalid-source" | "present-but-invalid";
      readonly capabilities: readonly { readonly hwCapabilityId: string }[];
    }[];
  };
}

/**
 * The explicit migration-lane proposal ingress. It computes current evidence,
 * conflict checks, authority disclosure, risk gates, and queues preparation
 * without consuming ordinary review attention slots.
 */
export interface HomeAutomationMigrationPreparationProposalPort {
  createMigrationDraftGoverned(
    input: CreateHomeMigrationDraftInput,
  ): Promise<ProposalCreationResult> | ProposalCreationResult;
}

export interface HomeAutomationMigrationPreparationOptions {
  readonly source: HomeAutomationMigrationPreparationCandidateSource;
  readonly world: HomeAutomationMigrationPreparationWorldPort;
  readonly proposals: HomeAutomationMigrationPreparationProposalPort;
}

export interface HomeAutomationMigrationPreparationInput {
  readonly migrationId: string;
  readonly ruleRef: string;
}

export interface HomeAutomationMigrationPreparationCallOptions {
  readonly signal?: AbortSignal;
}

export type HomeAutomationMigrationPreparationFailureReason =
  | "invalid_input"
  | "assessment_not_eligible"
  | "candidate_unavailable"
  | "stale_source"
  | "unsupported"
  | "scope_unavailable"
  | "capacity_full"
  | "suppressed"
  | "proposal_unavailable";

export type HomeAutomationMigrationPreparationResult =
  | {
    readonly outcome: "created" | "merged" | "replayed";
    readonly proposal: ProposalEnvelope;
    readonly mergedEvidenceCount?: number;
  }
  | {
    readonly outcome: "needs_attention";
    readonly reason: HomeAutomationMigrationPreparationFailureReason;
  };

const PROPOSAL_IDENTITY_VERSION = "home-automation-migration-proposal-v1";
const SOURCE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const MAX_ID_BYTES = 200;

/**
 * Creates review drafts from trusted migration candidates.
 *
 * This class deliberately owns no proposal store and exposes no approval,
 * artifact, deployment, or bridge-write method. The migration-lane proposal
 * ingress remains the single admission path, so evidence, dry-run, authority,
 * preparation, ArtifactProducer, and audit invariants stay with their owners.
 */
export class HomeAutomationMigrationPreparationService {
  private readonly source: HomeAutomationMigrationPreparationCandidateSource;
  private readonly world: HomeAutomationMigrationPreparationWorldPort;
  private readonly proposals: HomeAutomationMigrationPreparationProposalPort;

  constructor(options: HomeAutomationMigrationPreparationOptions) {
    let valid = false;
    try {
      valid = isRecord(options)
        && typeof options.source?.get === "function"
        && typeof options.source?.createArtifactCandidate === "function"
        && typeof options.world?.snapshot === "function"
        && typeof options.proposals?.createMigrationDraftGoverned === "function";
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new TypeError("home automation migration preparation ports are required");
    }
    this.source = options.source;
    this.world = options.world;
    this.proposals = options.proposals;
  }

  /**
   * Revalidates an assessed rule and submits only its neutral candidate to the
   * explicit migration-lane ingress. A full/latched migration lane returns a
   * fixed reason; ordinary review capacity is never consulted by this adapter.
   */
  async createReviewDraft(
    input: HomeAutomationMigrationPreparationInput,
    options: HomeAutomationMigrationPreparationCallOptions = {},
  ): Promise<HomeAutomationMigrationPreparationResult> {
    const parsedInput = readInput(input);
    if (parsedInput === undefined) return failure("invalid_input");
    const signal = readCallOptions(options);
    if (signal === null) return failure("invalid_input");

    let assessment: HomeAutomationMigrationAssessment | undefined;
    try {
      assessment = this.source.get(parsedInput.migrationId);
    } catch {
      return failure("assessment_not_eligible");
    }
    const sourceRule = eligibleSourceRule(assessment, parsedInput);
    if (sourceRule === undefined) return failure("assessment_not_eligible");

    let rawCandidate: HomeAutomationMigrationRuntimeCandidateResult;
    try {
      rawCandidate = await this.source.createArtifactCandidate(
        { migrationId: parsedInput.migrationId, ruleRef: parsedInput.ruleRef },
        signal === undefined ? {} : { signal },
      );
    } catch {
      return failure("candidate_unavailable");
    }
    const candidate = readCandidate(rawCandidate);
    if (candidate.status === "needs_attention") return failure(candidate.reason);
    if (candidate.sourceFingerprint !== sourceRule.sourceFingerprint
      || candidate.ruleRef !== parsedInput.ruleRef) {
      return failure("stale_source");
    }

    const selectedHwIds = readDeviceScope(this.world, candidate.content);
    if (selectedHwIds === undefined) return failure("scope_unavailable");

    const draft = createDraftInput(parsedInput, sourceRule, candidate, selectedHwIds);
    let result: ProposalCreationResult;
    try {
      result = await this.proposals.createMigrationDraftGoverned(draft);
    } catch {
      return failure("proposal_unavailable");
    }
    return mapProposalResult(result);
  }
}

type ReadCandidateResult =
  | (Pick<ForeignRuleArtifactCandidate, "sourceFingerprint" | "ruleRef" | "title" | "content"> & {
    readonly status: "candidate";
  })
  | { readonly status: "needs_attention"; readonly reason: HomeAutomationMigrationPreparationFailureReason };

interface EligibleSourceRule {
  readonly sourceFingerprint: string;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
}

function createDraftInput(
  input: HomeAutomationMigrationPreparationInput,
  sourceRule: EligibleSourceRule,
  candidate: Extract<ReadCandidateResult, { readonly status: "candidate" }>,
  selectedHwIds: readonly string[],
): CreateHomeMigrationDraftInput {
  const identity = sourceIdentity(input, sourceRule);
  return {
    kind: "automation-draft",
    title: candidate.title,
    summary: "请在启用前查看这条迁移的自动化。",
    dedupKey: `home-automation-migration:${identity}`,
    idempotencyKey: `home-automation-migration-attempt:${identity}`,
    selectedHwIds,
    // This is the fixed migration-lane policy floor, not a claim inferred
    // from foreign content. The lane always requires a household decision.
    risk: {
      level: "medium",
      reasons: ["迁移行为在启用前需要家庭成员确认。"],
    },
    intent: {
      type: "home-automation-migration",
      description: "查看这条迁移的自动化，再决定是否启用。",
      rollback: "拒绝或关闭这条方案；审批和部署前不会改变家中的行为。",
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: candidate.content,
    },
    rationale: {
      householdValue: "保留可能有用的家庭行为，同时由家庭成员掌握决定权。",
      whyNow: "这条迁移行为已通过当前翻译检查，可以交给家庭查看。",
      uncertainties: [
        "家庭成员尚未批准这条行为。",
        "后续部署前仍需重新检查当前家庭证据和准备结果。",
      ],
    },
  };
}

function sourceIdentity(
  input: HomeAutomationMigrationPreparationInput,
  sourceRule: EligibleSourceRule,
): string {
  const material = [
    PROPOSAL_IDENTITY_VERSION,
    input.migrationId,
    input.ruleRef,
    sourceRule.sourceBridgeId,
    sourceRule.sourceEpochId,
    String(sourceRule.sourceLastSeq),
    sourceRule.sourceFingerprint,
  ].join("\u0000");
  // The source cut is included in both behavior and attempt identity. A
  // changed fingerprint or watermark therefore never reuses an old draft.
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function eligibleSourceRule(
  assessment: HomeAutomationMigrationAssessment | undefined,
  input: HomeAutomationMigrationPreparationInput,
): EligibleSourceRule | undefined {
  try {
    if (!isRecord(assessment)
      || assessment.migrationId !== input.migrationId
      || assessment.status !== "assessed"
      || !Array.isArray(assessment.rules)
      || !isBoundedId(assessment.sourceBridgeId)
      || !isBoundedId(assessment.sourceEpochId)
      || !Number.isSafeInteger(assessment.sourceLastSeq)
      || assessment.sourceLastSeq <= 0) {
      return undefined;
    }
    const matches = assessment.rules.filter((rule): rule is HomeAutomationMigrationRuleAssessment =>
      isRecord(rule) && rule.ruleRef === input.ruleRef);
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    if (match?.disposition !== "eligible" || !isFingerprint(match.sourceFingerprint)) return undefined;
    return {
      sourceFingerprint: match.sourceFingerprint,
      sourceBridgeId: assessment.sourceBridgeId,
      sourceEpochId: assessment.sourceEpochId,
      sourceLastSeq: assessment.sourceLastSeq,
    };
  } catch {
    return undefined;
  }
}

function readCandidate(value: unknown): ReadCandidateResult {
  try {
    if (!isRecord(value)) return { status: "needs_attention", reason: "candidate_unavailable" };
    if (value.status === "needs_attention") {
      if (!exactKeys(value, ["status", "reason"])) {
        return { status: "needs_attention", reason: "candidate_unavailable" };
      }
      return { status: "needs_attention", reason: mapCandidateAttentionReason(value.reason) };
    }
    if (value.status !== "candidate"
      || !exactKeys(value, ["status", "sourceFingerprint", "ruleRef", "title", "content"])
      || !isFingerprint(value.sourceFingerprint)
      || !isBoundedId(value.ruleRef)
      || !isArtifactTitle(value.title)) {
      return { status: "needs_attention", reason: "candidate_unavailable" };
    }
    let content: ArtifactContent;
    try {
      content = parseArtifactContent(value.content);
    } catch {
      return { status: "needs_attention", reason: "candidate_unavailable" };
    }
    return {
      status: "candidate",
      sourceFingerprint: value.sourceFingerprint,
      ruleRef: value.ruleRef,
      title: value.title,
      content,
    };
  } catch {
    return { status: "needs_attention", reason: "candidate_unavailable" };
  }
}

function readDeviceScope(world: HomeAutomationMigrationPreparationWorldPort, content: ArtifactContent): readonly string[] | undefined {
  const capabilityIds = artifactCapabilityIds(content);
  if (capabilityIds.length === 0) return undefined;
  try {
    const snapshot = world.snapshot();
    if (!isRecord(snapshot) || !Array.isArray(snapshot.devices)) return undefined;
    const owners = new Map<string, Array<{ readonly hwId: string; readonly validity: string }>>();
    for (const device of snapshot.devices) {
      if (!isRecord(device)
        || !isBoundedId(device.hwId)
        || !isDeviceValidity(device.validity)
        || !Array.isArray(device.capabilities)) return undefined;
      for (const capability of device.capabilities) {
        if (!isRecord(capability) || !isBoundedId(capability.hwCapabilityId)) return undefined;
        const list = owners.get(capability.hwCapabilityId) ?? [];
        list.push({ hwId: device.hwId, validity: device.validity });
        owners.set(capability.hwCapabilityId, list);
      }
    }
    const selected = new Set<string>();
    for (const capabilityId of capabilityIds) {
      const matches = owners.get(capabilityId);
      if (matches === undefined || matches.length !== 1) return undefined;
      if (matches[0]?.validity !== "valid") return undefined;
      selected.add(matches[0].hwId);
    }
    const selectedHwIds = [...selected].sort(compareStrings);
    return selectedHwIds.length > 0 && selectedHwIds.length <= 20 ? selectedHwIds : undefined;
  } catch {
    return undefined;
  }
}

function artifactCapabilityIds(content: ArtifactContent): readonly string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids];
}

function mapProposalResult(result: ProposalCreationResult): HomeAutomationMigrationPreparationResult {
  try {
    if (result.kind === "created" || result.kind === "merged" || result.kind === "replayed") {
      return {
        outcome: result.kind,
        proposal: result.proposal,
        ...(result.kind === "merged" && result.mergedEvidenceCount === undefined
          ? {}
          : result.kind === "merged" ? { mergedEvidenceCount: result.mergedEvidenceCount } : {}),
      };
    }
    if (result.kind === "capacity_full") return failure("capacity_full");
    if (result.kind === "suppressed") return failure("suppressed");
  } catch {
    // The proposal owner is a Hub port; malformed output still stays closed.
  }
  return failure("proposal_unavailable");
}

function mapCandidateAttentionReason(value: unknown): HomeAutomationMigrationPreparationFailureReason {
  switch (value) {
    case "unsupported": return "unsupported";
    case "stale_source": return "stale_source";
    case "translation_unavailable": return "candidate_unavailable";
    case "unsupported_trigger": return "unsupported";
    case "unsupported_condition": return "unsupported";
    case "unsupported_action": return "unsupported";
    case "assessment_not_eligible": return "assessment_not_eligible";
    case "invalid_input":
    case "resolver_failed":
    case "unbound_target":
    case "multiple_targets":
    case "invalid_title":
    case "artifact_invalid":
    default: return "candidate_unavailable";
  }
}

function failure(reason: HomeAutomationMigrationPreparationFailureReason): HomeAutomationMigrationPreparationResult {
  return { outcome: "needs_attention", reason };
}

function readInput(value: unknown): HomeAutomationMigrationPreparationInput | undefined {
  try {
    if (!isRecord(value)
      || !exactKeys(value, ["migrationId", "ruleRef"])
      || !isBoundedId(value.migrationId)
      || !isBoundedId(value.ruleRef)) return undefined;
    return { migrationId: value.migrationId, ruleRef: value.ruleRef };
  } catch {
    return undefined;
  }
}

function readCallOptions(value: unknown): AbortSignal | undefined | null {
  try {
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    if (!exactKeys(value, ["signal"])) return null;
    if (value.signal === undefined) return undefined;
    return isAbortSignal(value.signal) ? value.signal : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_BYTES
    && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
    && value.trim() === value;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && SOURCE_FINGERPRINT.test(value);
}

function isArtifactTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDeviceValidity(value: unknown): value is "valid" | "stale" | "invalid-source" | "present-but-invalid" {
  return value === "valid"
    || value === "stale"
    || value === "invalid-source"
    || value === "present-but-invalid";
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    return isRecord(value)
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function";
  } catch {
    return false;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
