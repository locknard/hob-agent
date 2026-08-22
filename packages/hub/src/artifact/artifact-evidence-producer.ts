import {
  canonicalAssessmentInput,
  computeAssessmentInputIdentity,
  computeProposalEvidenceIdentity,
  createArtifactEvidenceAttestation,
  type ArtifactEvidenceAttestation,
} from "./artifact-assessments.js";
import type {
  ArtifactAssessmentEntry,
  ArtifactRegistryEntry,
} from "./artifact-registry.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldEvidenceCoverage,
  HomeWorldEvidenceQuery,
  HomeWorldEvidenceResult,
  HomeWorldSnapshot,
} from "../home-world-service.js";
import {
  artifactRefSchema,
  type ArtifactContent,
  type ArtifactRef,
} from "./neutral-artifact.js";
import type {
  ApprovedProposalSource,
} from "./artifact-producer.js";
import type { HubVerifiedProposalSource } from "../proposal-store.js";

/** The exact approved Proposal source port used by ArtifactProducer. */
export type ApprovedArtifactProposalSource = ApprovedProposalSource;

/**
 * Read-only HomeWorld seam needed by this unmounted producer. The producer
 * obtains the temporal result and then reads the current manifest-verified
 * watermark vector; callers cannot provide either value.
 */
export interface ArtifactEvidenceHomeWorldPort {
  readonly queryRecentEvidence: (input: HomeWorldEvidenceQuery) => HomeWorldEvidenceResult;
  readonly snapshot: () => Pick<HomeWorldSnapshot, "bridgeWatermarks" | "bridges">;
}

/** Naming seam for callers that refer to this dependency as a query port. */
export type HomeWorldEvidenceQueryPort = ArtifactEvidenceHomeWorldPort;
export type ArtifactEvidenceQueryPort = ArtifactEvidenceHomeWorldPort;

/** Narrow Registry seam: exact revision read plus immutable evidence append. */
export interface ArtifactEvidenceRegistry {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
  readonly listAttestations: (query: {
    readonly kind: "evidence-attestation";
    readonly artifact: ArtifactRef;
    readonly limit?: number;
  }) => readonly ArtifactAssessmentEntry[];
  readonly recordEvidenceAttestation: (input: {
    readonly assessment: ArtifactEvidenceAttestation;
    readonly idempotencyKey: string;
    readonly actor?: string;
  }) => ArtifactAssessmentEntry;
}

export type ArtifactEvidenceRegistryPort = ArtifactEvidenceRegistry;

export interface ArtifactEvidenceProducerOptions {
  readonly proposals: ApprovedArtifactProposalSource;
  readonly homeWorld: ArtifactEvidenceHomeWorldPort;
  readonly registry: ArtifactEvidenceRegistry;
  /** Hub-owned capture clock; never accepted in the production request. */
  readonly now?: () => string;
}

export interface ArtifactEvidenceProductionRequest {
  readonly artifact: ArtifactRef;
}

export type ArtifactEvidenceProducerErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "unavailable"
  | "invalid_source";

export class ArtifactEvidenceProducerError extends Error {
  readonly code: ArtifactEvidenceProducerErrorCode;

  constructor(code: ArtifactEvidenceProducerErrorCode, message: string) {
    super(message);
    this.name = "ArtifactEvidenceProducerError";
    this.code = code;
  }
}

const PRODUCER_VERSION = "artifact-evidence-producer-v1";
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_QUERY_EVENTS = 200;
const PRODUCER_ACTOR = "hub-artifact-evidence-producer";

/**
 * Produces one immutable, non-applying evidence attestation for an exact
 * Artifact revision. The class is deliberately unmounted: it has no bridge,
 * control, credential, or execution dependency.
 */
export class ArtifactEvidenceProducer {
  private readonly proposals: ApprovedArtifactProposalSource;
  private readonly homeWorld: ArtifactEvidenceHomeWorldPort;
  private readonly registry: ArtifactEvidenceRegistry;
  private readonly now: () => string;

  constructor(options: ArtifactEvidenceProducerOptions) {
    if (!options || typeof options !== "object") {
      throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence producer options are required");
    }
    if (!options.proposals || typeof options.proposals.withApprovedProposalAtRevision !== "function") {
      throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence producer requires an approved Proposal source");
    }
    if (!options.homeWorld
      || typeof options.homeWorld.queryRecentEvidence !== "function"
      || typeof options.homeWorld.snapshot !== "function") {
      throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence producer requires a HomeWorld evidence port");
    }
    if (!options.registry
      || typeof options.registry.getRevision !== "function"
      || typeof options.registry.listAttestations !== "function"
      || typeof options.registry.recordEvidenceAttestation !== "function") {
      throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence producer requires an Artifact Registry");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence producer clock must be callable");
    }
    this.proposals = options.proposals;
    this.homeWorld = options.homeWorld;
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  produce(request: ArtifactEvidenceProductionRequest): ArtifactAssessmentEntry {
    const artifactRef = parseProductionRequest(request);
    const entry = this.registry.getRevision(artifactRef.artifactId, artifactRef.revision);
    if (entry === undefined) {
      throw new ArtifactEvidenceProducerError("not_found", "Artifact revision was not found");
    }
    if (!sameArtifactRef(entry.artifact, artifactRef)) {
      throw new ArtifactEvidenceProducerError("revision_conflict", "Artifact ref does not match the stored revision");
    }

    const sourceProposal = entry.artifact.sourceProposal;
    return this.proposals.withApprovedProposalAtRevision(
      sourceProposal.proposalId,
      sourceProposal.proposalRevision,
      (source) => this.produceForSource(entry, source),
    );
  }

  private produceForSource(
    entry: ArtifactRegistryEntry,
    source: HubVerifiedProposalSource,
  ): ArtifactAssessmentEntry {
    const artifact = entry.artifact;
    assertApprovedSourceMatchesArtifact(source, artifact);
    let proposalEvidenceIdentity: string;
    try {
      proposalEvidenceIdentity = computeProposalEvidenceIdentity(source.evidence);
    } catch {
      throw new ArtifactEvidenceProducerError("invalid_source", "Approved Proposal evidence is not canonical");
    }
    const selectedHwCapabilityIds = capabilityRefsFromContent(artifact.content);
    if (selectedHwCapabilityIds.length > 16) {
      throw new ArtifactEvidenceProducerError("invalid_source", "Artifact capability evidence selection exceeds its bound");
    }
    const capture = this.capture(selectedHwCapabilityIds);
    const sourceProposal = artifact.sourceProposal;
    const identityInput = {
      artifact: {
        artifactId: artifact.artifactId,
        revision: artifact.revision,
        contentHash: artifact.contentHash,
      },
      source: "home-world-consistent-cut" as const,
      sourceProposal,
      proposalEvidenceIdentity,
      selectedHwCapabilityIds,
      watermarks: capture.watermarks,
      coverage: capture.coverage,
      reasons: capture.reasons,
    };
    const inputIdentity = computeAssessmentInputIdentity("evidence", identityInput);
    const digest = inputIdentity.slice("sha256:".length);
    const assessment = createArtifactEvidenceAttestation({
      ...identityInput,
      attestationId: `${PRODUCER_VERSION}-${digest}`,
      capturedAt: this.now(),
    });
    if (assessment.inputIdentity !== inputIdentity) {
      throw new ArtifactEvidenceProducerError("invalid_source", "Evidence assessment identity did not stabilize");
    }
    const existing = this.findExisting(assessment);
    const replayAssessment = existing === undefined ? assessment : existing;
    try {
      return this.registry.recordEvidenceAttestation({
        assessment: replayAssessment,
        idempotencyKey: `${PRODUCER_VERSION}-${digest}`,
        actor: PRODUCER_ACTOR,
      });
    } catch (error) {
      // A second producer may have crossed the initial bounded lookup while
      // the first transaction committed. Re-read the exact identity and bind
      // the same immutable payload before surfacing an unrelated failure.
      const raced = this.findExisting(assessment);
      if (raced === undefined) throw error;
      return this.registry.recordEvidenceAttestation({
        assessment: raced,
        idempotencyKey: `${PRODUCER_VERSION}-${digest}`,
        actor: PRODUCER_ACTOR,
      });
    }
  }

  private findExisting(assessment: ArtifactEvidenceAttestation): ArtifactEvidenceAttestation | undefined {
    const existing = this.registry.listAttestations({
      kind: "evidence-attestation",
      artifact: assessment.artifact,
      limit: 200,
    }).find((item) => item.inputIdentity === assessment.inputIdentity);
    if (existing === undefined) return undefined;
    if (existing.kind !== "evidence-attestation" || existing.assessment.kind !== "evidence-attestation") {
      throw new ArtifactEvidenceProducerError("invalid_source", "Registry returned a non-evidence row for evidence identity");
    }
    return existing.assessment;
  }

  private capture(selectedHwCapabilityIds: readonly string[]): EvidenceCapture {
    if (selectedHwCapabilityIds.length === 0) {
      return captureFromSnapshot(this.homeWorld.snapshot());
    }
    const result = this.homeWorld.queryRecentEvidence({
      hwCapabilityIds: selectedHwCapabilityIds,
      lookbackHours: DEFAULT_LOOKBACK_HOURS,
      limit: MAX_QUERY_EVENTS,
    });
    return captureFromResult(result, this.homeWorld.snapshot());
  }
}

interface EvidenceCapture {
  readonly watermarks: ArtifactEvidenceAttestation["watermarks"];
  readonly coverage: ArtifactEvidenceAttestation["coverage"];
  readonly reasons: ArtifactEvidenceAttestation["reasons"];
}

function parseProductionRequest(value: unknown): ArtifactRef {
  if (value === null || typeof value !== "object") {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "artifact") {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request contains unsupported fields");
  }
  const artifactValue = (value as { readonly artifact?: unknown }).artifact;
  if (artifactValue === null || typeof artifactValue !== "object") {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request ref is invalid");
  }
  const artifactPrototype = Object.getPrototypeOf(artifactValue);
  if (artifactPrototype !== Object.prototype && artifactPrototype !== null) {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request ref is invalid");
  }
  const artifactKeys = Reflect.ownKeys(artifactValue);
  if (artifactKeys.length !== 3
    || !artifactKeys.every((key) => key === "artifactId" || key === "revision" || key === "contentHash")) {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request ref is invalid");
  }
  const parsed = artifactRefSchema.safeParse(artifactValue);
  if (!parsed.success) {
    throw new ArtifactEvidenceProducerError("invalid_input", "Artifact evidence request ref is invalid");
  }
  return parsed.data;
}

function sameArtifactRef(artifact: ArtifactRegistryEntry["artifact"], ref: ArtifactRef): boolean {
  return artifact.artifactId === ref.artifactId
    && artifact.revision === ref.revision
    && artifact.contentHash === ref.contentHash;
}

function assertApprovedSourceMatchesArtifact(
  source: HubVerifiedProposalSource,
  artifact: ArtifactRegistryEntry["artifact"],
): void {
  let contentMatches = false;
  if (source !== null && typeof source === "object"
    && source.artifactCandidate !== undefined
    && source.artifactCandidate.schemaVersion === "1") {
    try {
      contentMatches = canonicalAssessmentInput(source.artifactCandidate.content)
        === canonicalAssessmentInput(artifact.content);
    } catch {
      contentMatches = false;
    }
  }
  if (source === null || typeof source !== "object"
    || source.proposalId !== artifact.sourceProposal.proposalId
    || source.revision !== artifact.sourceProposal.proposalRevision
    || source.kind !== "automation-draft"
    || source.status !== "approved"
    || source.applicationStatus !== "not_available"
    || source.artifactCandidate === undefined
    || source.artifactCandidate.schemaVersion !== "1"
    || !contentMatches) {
    throw new ArtifactEvidenceProducerError("invalid_source", "Approved Proposal source does not match the Artifact");
  }
}

function capabilityRefsFromContent(content: ArtifactContent): string[] {
  const ids = new Set<string>();
  if (content.trigger.kind === "capability_changed") ids.add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) ids.add(condition.source.hwCapabilityId);
  for (const action of content.actions) {
    if (action.kind !== "notify_local") ids.add(action.target.hwCapabilityId);
  }
  if (content.rollback.kind === "restore_previous_state") ids.add(content.rollback.target.hwCapabilityId);
  for (const postcondition of content.postconditions) ids.add(postcondition.source.hwCapabilityId);
  return [...ids].sort(compareUnicodeCodePoints);
}

function captureFromResult(
  result: HomeWorldEvidenceResult,
  snapshot: Pick<HomeWorldSnapshot, "bridgeWatermarks" | "bridges">,
): EvidenceCapture {
  return captureFromCoverage(result.coverage, snapshot);
}

function captureFromSnapshot(
  snapshot: Pick<HomeWorldSnapshot, "bridgeWatermarks" | "bridges">,
): EvidenceCapture {
  const watermarks = new Map(snapshot.bridgeWatermarks.map((item) => [item.bridgeId, item] as const));
  const coverage = Object.keys(snapshot.bridges).sort(compareUnicodeCodePoints).map((bridgeId) => {
    const bridge = snapshot.bridges[bridgeId]!;
    const watermark = watermarks.get(bridgeId);
    return coverageFromBridgeSnapshot(bridge, watermark);
  });
  return captureFromCoverage(coverage, snapshot);
}

function coverageFromBridgeSnapshot(
  bridge: HomeWorldBridgeSnapshot,
  watermark: HomeWorldSnapshot["bridgeWatermarks"][number] | undefined,
): HomeWorldEvidenceCoverage {
  if (watermark === undefined) {
    return {
      bridgeId: bridge.bridgeId,
      status: "unavailable",
      reasons: ["missing_consistent_baseline"],
    };
  }
  const reasons = [
    ...(bridge.metrics.consistency === "ready" ? [] : ["bridge_not_ready" as const]),
    ...(bridge.diagnostics.lastSyncCompleteAt === undefined ? ["baseline_time_unknown" as const] : []),
  ];
  return {
    bridgeId: bridge.bridgeId,
    epochId: watermark.epochId,
    baselineSeq: watermark.lastSeq,
    ...(watermark.lastSyncCompleteAt === undefined ? {} : { baselineAt: watermark.lastSyncCompleteAt }),
    status: reasons.length === 0 ? "complete" : "partial",
    reasons,
  };
}

function captureFromCoverage(
  rawCoverage: readonly HomeWorldEvidenceCoverage[],
  snapshot: Pick<HomeWorldSnapshot, "bridgeWatermarks" | "bridges">,
): EvidenceCapture {
  const coverage = [...rawCoverage]
    .sort((left, right) => compareUnicodeCodePoints(left.bridgeId, right.bridgeId))
    .map((item) => {
      const bridge = snapshot.bridges[item.bridgeId];
      const diagnostics = bridge?.diagnostics;
      const reasons = new Set(item.reasons);
      let status = item.status;
      let freshness: "fresh" | "stale" | "unknown";
      let gapCount: number;
      if (diagnostics === undefined) {
        freshness = "unknown";
        gapCount = 0;
        if (reasons.has("history_gap")) {
          throw new ArtifactEvidenceProducerError(
            "unavailable",
            "HomeWorld reported a history gap without an exact diagnostic gap count",
          );
        }
        if (status === "complete") status = "partial";
        if (status !== "unavailable") reasons.add("journal_query_unavailable");
      } else {
        freshness = diagnostics.connectionState === "ready" ? "fresh" : "stale";
        gapCount = diagnostics.historyGapCount;
        if (reasons.has("history_gap") && gapCount < 1) {
          throw new ArtifactEvidenceProducerError(
            "unavailable",
            "HomeWorld reported a history gap without an exact diagnostic gap count",
          );
        }
        if (gapCount > 0 && status === "complete") {
          status = "partial";
          reasons.add("history_gap");
        }
        if (diagnostics.connectionState !== "ready" && status === "complete") {
          status = "partial";
          reasons.add("bridge_not_ready");
        }
        if (diagnostics.lastSyncCompleteAt === undefined && status === "complete") {
          status = "partial";
          reasons.add("baseline_time_unknown");
        }
      }
      return {
      bridgeId: item.bridgeId,
      ...(item.epochId === undefined ? {} : { epochId: item.epochId }),
      ...(item.baselineSeq === undefined ? {} : { baselineSeq: item.baselineSeq }),
      ...(item.baselineAt === undefined ? {} : { baselineAt: item.baselineAt }),
      status,
      reasons: [...reasons].sort(compareUnicodeCodePoints),
      freshness,
      gapCount,
      };
    });
  const snapshotWatermarks = new Map(snapshot.bridgeWatermarks.map((item) => [item.bridgeId, item] as const));
  const watermarks = coverage.flatMap((item) => {
    const snapshotWatermark = snapshotWatermarks.get(item.bridgeId);
    if (snapshotWatermark !== undefined) {
      if (item.epochId === undefined || item.baselineSeq === undefined
        || item.epochId !== snapshotWatermark.epochId
        || item.baselineSeq !== snapshotWatermark.lastSeq) {
        throw new ArtifactEvidenceProducerError("unavailable", "HomeWorld consistency watermark changed during evidence capture");
      }
      return [{
        bridgeId: snapshotWatermark.bridgeId,
        epochId: snapshotWatermark.epochId,
        lastSeq: snapshotWatermark.lastSeq,
        ...(snapshotWatermark.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: snapshotWatermark.lastSyncCompleteAt }),
        freshness: item.freshness,
        gapCount: item.gapCount,
      }];
    }
    if (item.epochId !== undefined && item.baselineSeq !== undefined) {
      return [{
        bridgeId: item.bridgeId,
        epochId: item.epochId,
        lastSeq: item.baselineSeq,
        freshness: item.freshness,
        gapCount: item.gapCount,
      }];
    }
    return [];
  });
  if (watermarks.length === 0) {
    throw new ArtifactEvidenceProducerError("unavailable", "HomeWorld returned no consistent watermark");
  }
  const reasons = [...new Set(coverage.flatMap((item) => item.reasons))].sort(compareUnicodeCodePoints);
  const status = coverage.some((item) => item.status === "unavailable")
    ? "unavailable"
    : coverage.some((item) => item.status === "partial") ? "partial" : "complete";
  return { watermarks, coverage: status, reasons };
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
