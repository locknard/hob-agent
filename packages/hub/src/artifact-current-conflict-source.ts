import {
  canonicalAssessmentInput,
  computeConflictInputIdentity,
  parseArtifactEvidenceAttestation,
  type ArtifactEvidenceAttestation,
} from "./artifact-assessments.js";
import {
  createNeutralConflictInput,
  createNeutralConflictResult,
  computeNeutralForeignCatalogIdentity,
  type NeutralConflictInput,
  type NeutralConflictResult,
  type NeutralCurrentConflict,
  type NeutralWatermark,
} from "./artifact-compiler-contract.js";
import type { ArtifactRegistryEntry } from "./artifact-registry.js";
import type {
  ArtifactRiskConflictFinding,
  ArtifactRiskConflictPort,
  ArtifactRiskConflictQuery,
  ArtifactRiskConflictResult,
} from "./artifact-risk-producer.js";
import type { ApprovedProposalSource } from "./artifact-producer.js";
import {
  artifactRefSchema,
  parseArtifactContent,
  parseArtifactRevision,
  type ArtifactContent,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import type { HubVerifiedProposalSource } from "./proposal-store.js";
import type {
  HomeWorldBridgeSnapshot,
  HomeWorldCapabilitySnapshot,
  HomeWorldForeignRuleCatalog,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "./home-world-service.js";

const MAX_CAPABILITY_IDS = 16;
const MAX_RELEVANT_BRIDGES = 16;
const MAX_CATALOG_ROWS = 1_024;
const MAX_FINDINGS = 20;
const MAX_ID_BYTES = 200;
const MAX_RULE_NAME_BYTES = 1_024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UNAVAILABLE_SOURCE_IDENTITY = `sha256:${"0".repeat(64)}`;

const OVERLAP_STOP_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "if", "in", "into", "is", "it", "of", "on", "or",
  "that", "the", "then", "this", "to", "when", "with",
]);

/** The neutral HomeWorld read methods needed by this unmounted capture seam. */
export interface ArtifactCurrentConflictHomeWorldPort {
  readonly snapshot: () => HomeWorldSnapshot;
  readonly foreignRuleCatalog: () => Promise<readonly HomeWorldForeignRuleCatalog[]>;
}

/** The exact approved Proposal source used to read title, summary, and intent. */
export interface ArtifactCurrentConflictCapturePort {
  readonly capture: (input: {
    readonly artifact: ArtifactRef;
    readonly evidence: ArtifactEvidenceAttestation;
  }) => Promise<ArtifactCurrentConflictCapture>;
}

/**
 * The synchronous result of one stable current-rule capture. The compile cut
 * is deliberately separate from the assessment port so an unavailable
 * capture cannot be mistaken for an empty current catalog.
 */
export interface ArtifactCurrentConflictCapture extends ArtifactRiskConflictPort {
  readonly compileCut: () => ArtifactCurrentConflictCompileCut | undefined;
}

export interface ArtifactCurrentConflictCompileCut {
  readonly currentConflict: NeutralCurrentConflict;
  readonly foreignRuleChecks: readonly NeutralConflictInput[];
  readonly foreignCatalogIdentity: string;
}

/** Read-only exact draft Registry seam used during capture. */
export interface ArtifactCurrentConflictArtifactRegistry {
  readonly getRevision: (artifactId: string, revision: number) => ArtifactRegistryEntry | undefined;
}

export interface ArtifactCurrentConflictSourceOptions {
  readonly proposals: ApprovedProposalSource;
  readonly registry: ArtifactCurrentConflictArtifactRegistry;
  readonly homeWorld: ArtifactCurrentConflictHomeWorldPort;
  /** Existing Hub-owned source-bound conflict result provider. */
  readonly existing: ArtifactRiskConflictPort;
}

export type ArtifactCurrentConflictSourceErrorCode = "invalid_input";

export class ArtifactCurrentConflictSourceError extends Error {
  constructor(
    readonly code: ArtifactCurrentConflictSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactCurrentConflictSourceError";
  }
}

interface ApprovedConflictText {
  readonly title: string;
  readonly summary: string;
  readonly intent: {
    readonly type: string;
    readonly description: string;
    readonly rollback: string;
  };
}

interface WorldBridgeCut {
  readonly bridgeId: string;
  readonly watermark: HomeWorldWatermark;
  readonly freshness: "fresh";
  readonly gapCount: 0;
  readonly fingerprint: string;
}

interface WorldCut {
  readonly bridges: readonly WorldBridgeCut[];
  readonly fingerprint: string;
}

interface CatalogRule {
  readonly ruleRef: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
}

interface CurrentCatalog {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly rules: readonly CatalogRule[];
  readonly identity: string;
}

interface ExistingConflict {
  readonly result: ArtifactRiskConflictResult;
  readonly findings: readonly ArtifactRiskConflictFinding[];
}

/**
 * Hub-private, unmounted asynchronous current-rule capture.
 *
 * Capture owns the only asynchronous catalog read. It returns a synchronous
 * immutable conflict port bound to one exact ArtifactRef, complete evidence,
 * derived capability scope, and a stable HomeWorld/catalog cut. It has no
 * bridge, control, credential, network, or mutation capability.
 */
export class ArtifactCurrentConflictSource implements ArtifactCurrentConflictCapturePort {
  private readonly proposals: ApprovedProposalSource;
  private readonly registry: ArtifactCurrentConflictArtifactRegistry;
  private readonly homeWorld: ArtifactCurrentConflictHomeWorldPort;
  private readonly existing: ArtifactRiskConflictPort;

  constructor(options: ArtifactCurrentConflictSourceOptions) {
    if (!isPlainObject(options)
      || !hasExactKeys(options, ["proposals", "registry", "homeWorld", "existing"])
      || !options.proposals
      || typeof options.proposals.withApprovedProposalAtRevision !== "function") {
      throw new ArtifactCurrentConflictSourceError("invalid_input", "Approved Proposal source is required");
    }
    if (!options.registry || typeof options.registry.getRevision !== "function") {
      throw new ArtifactCurrentConflictSourceError("invalid_input", "Artifact Registry read seam is required");
    }
    if (!options.homeWorld
      || typeof options.homeWorld.snapshot !== "function"
      || typeof options.homeWorld.foreignRuleCatalog !== "function") {
      throw new ArtifactCurrentConflictSourceError("invalid_input", "HomeWorld current-rule read seam is required");
    }
    const existing = options.existing;
    if (existing === undefined
      || (typeof existing !== "object" && typeof existing !== "function")
      || typeof existing.assess !== "function") {
      throw new ArtifactCurrentConflictSourceError("invalid_input", "Existing conflict source is required");
    }
    this.proposals = options.proposals;
    this.registry = options.registry;
    this.homeWorld = options.homeWorld;
    this.existing = existing;
  }

  /** Capture one exact ArtifactRef/evidence pair and return its immutable synchronous port. */
  async capture(input: {
    readonly artifact: ArtifactRef;
    readonly evidence: ArtifactEvidenceAttestation;
  }): Promise<ArtifactCurrentConflictCapture> {
    const requestedInput = parseCaptureInput(input);
    const requestedRef = requestedInput.artifact;
    const evidence = requestedInput.evidence;
    const draft = this.readExactDraft(requestedRef);
    if (draft === undefined) return unavailablePort(requestedRef, []);

    const capabilityIds = capabilityRefsFromContent(draft.content);
    if (capabilityIds.length > MAX_CAPABILITY_IDS || capabilityIds.some((id) => !boundedNeutralId(id))) {
      return unavailablePort(requestedRef, capabilityIds);
    }
    if (!validateEvidenceBindings(evidence, requestedRef, draft, capabilityIds)) {
      return unavailablePort(requestedRef, capabilityIds);
    }

    const approved = this.readApprovedProposal(draft);
    if (approved === undefined) return unavailablePort(requestedRef, capabilityIds);

    let beforeSnapshot: HomeWorldSnapshot;
    try {
      beforeSnapshot = this.homeWorld.snapshot();
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }
    const before = collectWorldCut(beforeSnapshot, capabilityIds, evidence.watermarks);
    if (before === undefined) return unavailablePort(requestedRef, capabilityIds);

    let rawCatalogs: readonly HomeWorldForeignRuleCatalog[];
    try {
      rawCatalogs = await this.homeWorld.foreignRuleCatalog();
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }

    let afterSnapshot: HomeWorldSnapshot;
    try {
      afterSnapshot = this.homeWorld.snapshot();
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }
    const after = collectWorldCut(afterSnapshot, capabilityIds, evidence.watermarks);
    if (after === undefined || before.fingerprint !== after.fingerprint) {
      return unavailablePort(requestedRef, capabilityIds);
    }

    const catalogs = normalizeCurrentCatalogs(rawCatalogs, before);
    if (catalogs === undefined) return unavailablePort(requestedRef, capabilityIds);

    const existing = this.readExisting(requestedRef, capabilityIds);
    if (existing === undefined) return unavailablePort(requestedRef, capabilityIds);

    let currentFindingsByBridge: readonly { readonly bridgeId: string; readonly findings: readonly ArtifactRiskConflictFinding[] }[];
    try {
      currentFindingsByBridge = catalogs.map((catalog) => ({
        bridgeId: catalog.bridgeId,
        findings: catalog.rules.length === 0 ? [] : [{
          kind: "foreign_rule" as const,
          severity: "warning" as const,
          reason: "possible_overlap" as const,
          reference: computeConflictInputIdentity({
            kind: "foreign-catalog-reference",
            bridgeId: catalog.bridgeId,
            catalogIdentity: catalog.identity,
          }),
        }],
      }));
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }
    const currentFindings = currentFindingsByBridge.flatMap(({ findings }) => findings);

    const findings = deduplicateFindings([...existing.findings, ...currentFindings]);
    if (findings.length > MAX_FINDINGS) return unavailablePort(requestedRef, capabilityIds);

    let foreignRuleChecks: readonly NeutralConflictInput[];
    let foreignCatalogIdentity: string;
    try {
      foreignRuleChecks = catalogs.map((catalog) => {
        const bridge = before.bridges.find((item) => item.bridgeId === catalog.bridgeId);
        const bridgeFindings = currentFindingsByBridge.find((item) => item.bridgeId === catalog.bridgeId);
        if (bridge === undefined || bridgeFindings === undefined) throw new Error("Current bridge cut is missing");
        return createNeutralConflictInput({
          bridgeId: catalog.bridgeId,
          epochId: catalog.epochId,
          watermark: semanticWatermark(bridge),
          catalogIdentity: catalog.identity,
          status: "current",
          findings: bridgeFindings.findings,
        } as NeutralConflictInput);
      });
      foreignCatalogIdentity = computeNeutralForeignCatalogIdentity(foreignRuleChecks);
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }

    let sourceIdentity: string;
    try {
      sourceIdentity = computeConflictInputIdentity({
        artifact: requestedRef,
        hwCapabilityIds: capabilityIds,
        evidenceAttestationId: evidence.attestationId,
        evidenceInputIdentity: evidence.inputIdentity,
        existingResult: existing.result,
        approvedText: {
          title: approved.title,
          summary: approved.summary,
          intent: approved.intent,
        },
        watermarks: before.bridges.map((bridge) => ({
          bridgeId: bridge.bridgeId,
          epochId: bridge.watermark.epochId,
          lastSeq: bridge.watermark.lastSeq,
          freshness: bridge.freshness,
          gapCount: bridge.gapCount,
        })),
        catalogs: catalogs.map((catalog) => ({
          bridgeId: catalog.bridgeId,
          epochId: catalog.epochId,
          // Every bounded metadata row is hashed before aggregation. The
          // catalog identity itself uses bounded chunks, so all 256 allowed
          // rows remain covered without exceeding assessment array budgets.
          catalogIdentity: catalog.identity,
        })),
        foreignCatalogIdentity,
      });
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }

    const result = composeResult(existing.result, findings, sourceIdentity);
    let compileCut: ArtifactCurrentConflictCompileCut;
    try {
      compileCut = makeCompileCut(result, sourceIdentity, foreignRuleChecks, foreignCatalogIdentity);
    } catch {
      return unavailablePort(requestedRef, capabilityIds);
    }
    return makePort(
      requestedRef,
      capabilityIds,
      result,
      compileCut,
    );
  }

  private readExactDraft(ref: ArtifactRef): ArtifactRevision | undefined {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.registry.getRevision(ref.artifactId, ref.revision);
    } catch {
      return undefined;
    }
    if (!isRegistryEntry(entry)
      || entry.status !== "draft"
      || entry.tombstone
      || !sameArtifactRef(entry.artifact, ref)) {
      return undefined;
    }
    try {
      return parseArtifactRevision(entry.artifact);
    } catch {
      return undefined;
    }
  }

  private readApprovedProposal(artifact: ArtifactRevision): ApprovedConflictText | undefined {
    try {
      const value = this.proposals.withApprovedProposalAtRevision(
        artifact.sourceProposal.proposalId,
        artifact.sourceProposal.proposalRevision,
        (source) => translateApprovedProposal(source, artifact),
      );
      if (isPromiseLike(value)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private readExisting(ref: ArtifactRef, capabilityIds: readonly string[]): ExistingConflict | undefined {
    let raw: unknown;
    try {
      raw = this.existing.assess(Object.freeze({
        artifact: Object.freeze({ ...ref }),
        hwCapabilityIds: Object.freeze([...capabilityIds]),
      }));
    } catch {
      return undefined;
    }
    if (isPromiseLike(raw)) return undefined;
    const result = normalizeExistingResult(raw);
    if (result === undefined || result.status === "unavailable") return undefined;
    return { result, findings: result.findings };
  }
}

function parseCaptureInput(value: unknown): {
  readonly artifact: ArtifactRef;
  readonly evidence: ArtifactEvidenceAttestation;
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifact", "evidence"])) {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Current conflict capture input is invalid");
  }
  const artifact = parseArtifactRef(value.artifact);
  let evidence: ArtifactEvidenceAttestation;
  try {
    evidence = parseArtifactEvidenceAttestation(value.evidence);
  } catch {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Evidence attestation is invalid");
  }
  return Object.freeze({ artifact, evidence });
}

function validateEvidenceBindings(
  evidence: ArtifactEvidenceAttestation,
  requestedRef: ArtifactRef,
  artifact: ArtifactRevision,
  capabilityIds: readonly string[],
): boolean {
  return sameArtifactRef(evidence.artifact, requestedRef)
    && sameArtifactRef(evidence.artifact, artifact)
    && evidence.sourceProposal.proposalId === artifact.sourceProposal.proposalId
    && evidence.sourceProposal.proposalRevision === artifact.sourceProposal.proposalRevision
    && sameStringArray(evidence.selectedHwCapabilityIds, capabilityIds)
    && evidence.coverage === "complete"
    && evidence.watermarks.length > 0
    && evidence.watermarks.length <= MAX_RELEVANT_BRIDGES
    && evidence.watermarks.every((watermark) => watermark.freshness === "fresh" && watermark.gapCount === 0);
}

function translateApprovedProposal(
  source: HubVerifiedProposalSource,
  artifact: ArtifactRevision,
): ApprovedConflictText {
  if (!isPlainObject(source)
    || !hasExactKeys(source, [
      "proposalId", "revision", "kind", "status", "applicationStatus", "title", "summary",
      "intent", "evidence", "conflictCheck", "risk", "artifactCandidate",
    ])
    || source.proposalId !== artifact.sourceProposal.proposalId
    || source.revision !== artifact.sourceProposal.proposalRevision
    || source.kind !== "automation-draft"
    || source.status !== "approved"
    || source.applicationStatus !== "not_available"
    || !isPlainObject(source.artifactCandidate)
    || !hasExactKeys(source.artifactCandidate, ["schemaVersion", "content"])
    || source.artifactCandidate.schemaVersion !== "1") {
    throw new Error("approved Proposal source does not match Artifact");
  }

  const sourceContent = parseArtifactContent(source.artifactCandidate.content);
  if (canonicalAssessmentInput(sourceContent) !== canonicalAssessmentInput(artifact.content)) {
    throw new Error("approved Proposal candidate does not match Artifact");
  }
  if (!isPlainObject(source.intent)
    || !hasExactKeys(source.intent, ["type", "description", "rollback"])
    || !boundedText(source.title, 16 * 1024)
    || !boundedText(source.summary, 16 * 1024)
    || !boundedText(source.intent.type, MAX_ID_BYTES)
    || !boundedText(source.intent.description, 16 * 1024)
    || !boundedText(source.intent.rollback, 16 * 1024)) {
    throw new Error("approved Proposal text is invalid");
  }
  return Object.freeze({
    title: source.title,
    summary: source.summary,
    intent: Object.freeze({
      type: source.intent.type,
      description: source.intent.description,
      rollback: source.intent.rollback,
    }),
  });
}

function collectWorldCut(
  snapshot: HomeWorldSnapshot,
  capabilityIds: readonly string[],
  evidenceWatermarks: readonly ArtifactEvidenceAttestation["watermarks"][number][],
): WorldCut | undefined {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.devices) || !isPlainObject(snapshot.bridges)) return undefined;
  const targetSet = new Set(capabilityIds);
  const expectedWatermarks = new Map(evidenceWatermarks.map((watermark) => [watermark.bridgeId, watermark]));
  if (expectedWatermarks.size !== evidenceWatermarks.length || expectedWatermarks.size > MAX_RELEVANT_BRIDGES) return undefined;
  const bridgeIds = new Set(expectedWatermarks.keys());
  const found = new Set<string>();

  for (const device of snapshot.devices) {
    if (!isPlainObject(device) || !Array.isArray(device.capabilities)) continue;
    if (device.validity !== "valid") continue;
    for (const capability of device.capabilities) {
      if (!isPlainObject(capability) || typeof capability.hwCapabilityId !== "string"
        || !targetSet.has(capability.hwCapabilityId)) continue;
      if (!isCapabilitySnapshot(capability)) return undefined;
      found.add(capability.hwCapabilityId);
      if (capability.bindings.length === 0) return undefined;
      for (const binding of capability.bindings) {
        if (!isPlainObject(binding) || !boundedNeutralId(binding.bridgeId)) return undefined;
        if (!expectedWatermarks.has(binding.bridgeId)) return undefined;
      }
    }
  }

  if (found.size !== capabilityIds.length || bridgeIds.size > MAX_RELEVANT_BRIDGES) return undefined;
  const bridges: WorldBridgeCut[] = [];
  for (const bridgeId of [...bridgeIds].sort(compareCodePoints)) {
    const bridge = readFreshBridge(snapshot, bridgeId, expectedWatermarks.get(bridgeId)!);
    if (bridge === undefined) return undefined;
    bridges.push(bridge);
  }
  try {
    return {
      bridges: Object.freeze(bridges.map((bridge) => Object.freeze(bridge))),
      fingerprint: canonicalAssessmentInput(bridges.map((bridge) => ({
        bridgeId: bridge.bridgeId,
        watermark: semanticWatermarkIdentity(bridge.watermark, bridge.freshness, bridge.gapCount),
      }))),
    };
  } catch {
    return undefined;
  }
}

function readFreshBridge(
  snapshot: HomeWorldSnapshot,
  bridgeId: string,
  expectedWatermark: ArtifactEvidenceAttestation["watermarks"][number],
): WorldBridgeCut | undefined {
  const bridge = snapshot.bridges[bridgeId];
  if (!isPlainObject(bridge)
    || bridge.bridgeId !== bridgeId
    || !isPlainObject(bridge.diagnostics)
    || !isPlainObject(bridge.metrics)
    || bridge.diagnostics.connectionState !== "ready"
    || bridge.metrics.consistency !== "ready"
    || bridge.metrics.connection !== "up"
    || !Number.isSafeInteger(bridge.diagnostics.historyGapCount)
    || bridge.diagnostics.historyGapCount !== 0
    || (bridge.diagnostics.recentHistoryGaps !== undefined
      && (!Array.isArray(bridge.diagnostics.recentHistoryGaps) || bridge.diagnostics.recentHistoryGaps.length !== 0))
    || !isPlainObject(bridge.watermark)) {
    return undefined;
  }

  const watermark = normalizeWatermark(bridge.watermark, bridgeId);
  if (watermark === undefined) return undefined;
  if (!sameSemanticWatermark(watermark, expectedWatermark)) return undefined;
  const vector = snapshot.watermarkVector?.[bridgeId];
  if (!sameWatermark(vector, watermark)) return undefined;
  if (!Array.isArray(snapshot.bridgeWatermarks) || !Array.isArray(snapshot.watermarks)) return undefined;
  const listed = snapshot.bridgeWatermarks.filter((candidate) => isPlainObject(candidate) && candidate.bridgeId === bridgeId);
  if (listed.length !== 1 || !sameWatermark(listed[0], watermark)) return undefined;
  const aliasListed = snapshot.watermarks.filter((candidate) => isPlainObject(candidate) && candidate.bridgeId === bridgeId);
  if (aliasListed.length !== 1 || !sameWatermark(aliasListed[0], watermark)) return undefined;

  return {
    bridgeId,
    watermark,
    freshness: "fresh",
    gapCount: 0,
    fingerprint: canonicalAssessmentInput({ watermark: semanticWatermarkIdentity(watermark, "fresh", 0) }),
  };
}

function normalizeWatermark(value: unknown, expectedBridgeId: string): HomeWorldWatermark | undefined {
  if (!isPlainObject(value)
    || !hasOnlyKeys(value, ["bridgeId", "epochId", "lastSeq", "lastSyncCompleteAt"])
    || value.bridgeId !== expectedBridgeId
    || !boundedNeutralId(value.bridgeId)
    || !boundedNeutralId(value.epochId)
    || typeof value.lastSeq !== "number"
    || !Number.isSafeInteger(value.lastSeq)
    || value.lastSeq < 0
    || (value.lastSyncCompleteAt !== undefined && !validTimestamp(value.lastSyncCompleteAt))) {
    return undefined;
  }
  return Object.freeze({
    bridgeId: value.bridgeId,
    epochId: value.epochId,
    lastSeq: value.lastSeq,
    ...(value.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: value.lastSyncCompleteAt }),
  });
}

function normalizeCurrentCatalogs(
  raw: unknown,
  cut: WorldCut,
): readonly CurrentCatalog[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_CATALOG_ROWS) return undefined;
  const relevant = new Map<string, CurrentCatalog>();
  const relevantIds = new Set(cut.bridges.map((bridge) => bridge.bridgeId));
  for (const candidate of raw) {
    if (!isPlainObject(candidate) || typeof candidate.bridgeId !== "string" || !relevantIds.has(candidate.bridgeId)) continue;
    if (relevant.has(candidate.bridgeId)) return undefined;
    const bridge = cut.bridges.find((item) => item.bridgeId === candidate.bridgeId);
    if (bridge === undefined) return undefined;
    const normalized = normalizeCurrentCatalog(candidate, bridge.watermark.epochId, bridge.watermark.lastSeq);
    if (normalized === undefined) return undefined;
    relevant.set(candidate.bridgeId, normalized);
  }
  if (relevant.size !== relevantIds.size) return undefined;
  return [...relevant.values()].sort((left, right) => compareCodePoints(left.bridgeId, right.bridgeId));
}

function normalizeCurrentCatalog(
  value: Record<string, unknown>,
  expectedEpochId: string,
  expectedLastSeq: number,
): CurrentCatalog | undefined {
  if (!hasExactKeys(value, ["bridgeId", "status", "epochId", "lastSeq", "rules"])
    || typeof value.bridgeId !== "string"
    || !boundedNeutralId(value.bridgeId)
    || value.status !== "available"
    || typeof value.epochId !== "string"
    || !boundedNeutralId(value.epochId)
    || value.epochId !== expectedEpochId
    || typeof value.lastSeq !== "number"
    || !Number.isSafeInteger(value.lastSeq)
    || value.lastSeq <= 0
    || value.lastSeq !== expectedLastSeq
    || !Array.isArray(value.rules)
    || value.rules.length > 256) {
    return undefined;
  }
  const rules: CatalogRule[] = [];
  for (const candidate of value.rules) {
    const rule = normalizeCatalogRule(candidate);
    if (rule === undefined) return undefined;
    rules.push(rule);
  }
  rules.sort(compareCatalogRules);
  let identity: string;
  try {
    identity = computeConflictInputIdentity({
      bridgeId: value.bridgeId,
      epochId: value.epochId,
      lastSeq: value.lastSeq,
      ruleMetadataChunks: hashRuleMetadata(value.bridgeId, rules),
    });
  } catch {
    return undefined;
  }
  return {
    bridgeId: value.bridgeId,
    epochId: value.epochId,
    lastSeq: value.lastSeq,
    rules: Object.freeze(rules.map((rule) => Object.freeze(rule))),
    identity,
  };
}

function hashRuleMetadata(bridgeId: string, rules: readonly CatalogRule[]): readonly string[] {
  const rowIdentities = rules.map((rule) => computeConflictInputIdentity({ bridgeId, rule }));
  const chunks: string[] = [];
  for (let offset = 0; offset < rowIdentities.length; offset += 64) {
    chunks.push(computeConflictInputIdentity({
      bridgeId,
      ruleMetadata: rowIdentities.slice(offset, offset + 64),
    }));
  }
  return chunks;
}

function normalizeCatalogRule(value: unknown): CatalogRule | undefined {
  if (!isPlainObject(value)
    || typeof value.ruleRef !== "string"
    || !boundedNeutralId(value.ruleRef)
    || (value.name !== undefined && !boundedText(value.name, MAX_RULE_NAME_BYTES))
    || (value.enabled !== undefined && typeof value.enabled !== "boolean")
    || (value.updatedAt !== undefined && (typeof value.updatedAt !== "string" || !validTimestamp(value.updatedAt)))) {
    return undefined;
  }
  const allowedKeys = ["ruleRef", "name", "enabled", "updatedAt"];
  if (!hasOnlyKeys(value, allowedKeys)) return undefined;
  return {
    ruleRef: value.ruleRef,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

function hasTextOverlap(name: string | undefined, text: ApprovedConflictText): boolean {
  if (name === undefined) return false;
  const ruleTokens = tokenSet(name);
  if (ruleTokens.size === 0) return false;
  const approvedTokens = new Set([
    ...tokenSet(text.title),
    ...tokenSet(text.summary),
    ...tokenSet(text.intent.description),
    ...tokenSet(text.intent.rollback),
  ]);
  for (const token of ruleTokens) if (approvedTokens.has(token)) return true;
  return false;
}

function tokenSet(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens
    .filter((token) => token.length >= 3 && !OVERLAP_STOP_WORDS.has(token))
    .slice(0, 128));
}

function composeResult(
  existing: ArtifactRiskConflictResult,
  findings: readonly ArtifactRiskConflictFinding[],
  sourceIdentity: string,
): ArtifactRiskConflictResult {
  const status = existing.status === "duplicate" || findings.some((finding) => finding.reason === "duplicate")
    ? "duplicate"
    : existing.status === "possible_overlap" || findings.length > 0 ? "possible_overlap" : "none";
  return freezeResult({ status, findings, sourceIdentity });
}

function semanticWatermark(bridge: WorldBridgeCut): NeutralWatermark {
  return Object.freeze({
    bridgeId: bridge.watermark.bridgeId,
    epochId: bridge.watermark.epochId,
    lastSeq: bridge.watermark.lastSeq,
    freshness: bridge.freshness,
    gapCount: bridge.gapCount,
  });
}

function semanticWatermarkIdentity(
  watermark: HomeWorldWatermark,
  freshness: WorldBridgeCut["freshness"],
  gapCount: WorldBridgeCut["gapCount"],
): { readonly bridgeId: string; readonly epochId: string; readonly lastSeq: number; readonly freshness: "fresh"; readonly gapCount: 0 } {
  return {
    bridgeId: watermark.bridgeId,
    epochId: watermark.epochId,
    lastSeq: watermark.lastSeq,
    freshness,
    gapCount,
  };
}

function makeCompileCut(
  result: ArtifactRiskConflictResult,
  sourceIdentity: string,
  foreignRuleChecks: readonly NeutralConflictInput[],
  foreignCatalogIdentity: string,
): ArtifactCurrentConflictCompileCut {
  const currentConflict = Object.freeze({
    sourceIdentity,
    result: createNeutralConflictResult({
      status: result.status,
      findings: result.findings.map((finding) => ({
        ...finding,
        // The neutral contract rejects the private unavailable reason. A
        // successful cut can only reach this projection after capture has
        // rejected unavailable results; the contract parser remains the
        // final closed-vocabulary guard.
        reason: finding.reason as NeutralConflictResult["findings"][number]["reason"],
      })),
    }),
  });
  return Object.freeze({
    currentConflict,
    foreignRuleChecks: Object.freeze(foreignRuleChecks.map((check) => Object.freeze(check))),
    foreignCatalogIdentity,
  });
}

function normalizeExistingResult(value: unknown): ArtifactRiskConflictResult | undefined {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["status", "findings", "sourceIdentity"])
    || (value.status !== "none" && value.status !== "duplicate" && value.status !== "possible_overlap" && value.status !== "unavailable")
    || !SHA256.test(String(value.sourceIdentity))
    || !Array.isArray(value.findings)
    || value.findings.length > MAX_FINDINGS) {
    return undefined;
  }
  if (typeof value.sourceIdentity !== "string") return undefined;
  const findings: ArtifactRiskConflictFinding[] = [];
  for (const candidate of value.findings) {
    const hwCapabilityId = isPlainObject(candidate) ? candidate.hwCapabilityId : undefined;
    const reference = isPlainObject(candidate) ? candidate.reference : undefined;
    if (!isPlainObject(candidate)
      || (candidate.kind !== "existing_artifact" && candidate.kind !== "foreign_rule" && candidate.kind !== "stale_evidence"
        && candidate.kind !== "authority_unavailable" && candidate.kind !== "target_invalid" && candidate.kind !== "policy_blocked")
      || (candidate.severity !== "blocking" && candidate.severity !== "warning")
      || (candidate.reason !== "existing_artifact" && candidate.reason !== "foreign_rule" && candidate.reason !== "stale_evidence"
        && candidate.reason !== "authority_unavailable" && candidate.reason !== "target_invalid" && candidate.reason !== "policy_blocked"
        && candidate.reason !== "duplicate" && candidate.reason !== "possible_overlap" && candidate.reason !== "conflict_unavailable")
      || (hwCapabilityId !== undefined && (typeof hwCapabilityId !== "string" || !boundedNeutralId(hwCapabilityId)))
      || (reference !== undefined && (typeof reference !== "string" || !SHA256.test(reference)))
      || !hasOnlyKeys(candidate, ["kind", "severity", "reason", "hwCapabilityId", "reference"])) {
      return undefined;
    }
    findings.push({
      kind: candidate.kind,
      severity: candidate.severity,
      reason: candidate.reason,
      ...(hwCapabilityId === undefined ? {} : { hwCapabilityId }),
      ...(reference === undefined ? {} : { reference }),
    });
  }
  return freezeResult({
    status: value.status,
    findings: deduplicateFindings(findings),
    sourceIdentity: value.sourceIdentity,
  });
}

function deduplicateFindings(findings: readonly ArtifactRiskConflictFinding[]): readonly ArtifactRiskConflictFinding[] {
  const seen = new Set<string>();
  const unique: ArtifactRiskConflictFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.kind,
      finding.severity,
      finding.reason,
      finding.hwCapabilityId ?? "",
      finding.reference ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique.sort((left, right) => compareCodePoints(
    `${left.kind}\u0000${left.severity}\u0000${left.reason}\u0000${left.hwCapabilityId ?? ""}\u0000${left.reference ?? ""}`,
    `${right.kind}\u0000${right.severity}\u0000${right.reason}\u0000${right.hwCapabilityId ?? ""}\u0000${right.reference ?? ""}`,
  ));
}

function unavailablePort(ref: ArtifactRef, capabilityIds: readonly string[]): ArtifactCurrentConflictCapture {
  return makePort(ref, capabilityIds, unavailableResult(), undefined);
}

function unavailableResult(): ArtifactRiskConflictResult {
  return freezeResult({
    status: "unavailable",
    findings: [{ kind: "stale_evidence", severity: "blocking", reason: "conflict_unavailable" }],
    sourceIdentity: UNAVAILABLE_SOURCE_IDENTITY,
  });
}

function makePort(
  ref: ArtifactRef,
  capabilityIds: readonly string[],
  result: ArtifactRiskConflictResult,
  compileCut: ArtifactCurrentConflictCompileCut | undefined,
): ArtifactCurrentConflictCapture {
  const boundRef = Object.freeze({ ...ref });
  const boundIds = Object.freeze([...capabilityIds]);
  const boundResult = freezeResult({
    status: result.status,
    findings: result.findings,
    sourceIdentity: result.sourceIdentity,
  });
  return Object.freeze({
    assess(input: ArtifactRiskConflictQuery): ArtifactRiskConflictResult {
      const query = normalizeConflictQuery(input);
      if (!sameArtifactRef(query.artifact, boundRef) || !sameStringArray(query.hwCapabilityIds, boundIds)) {
        throw new ArtifactCurrentConflictSourceError("invalid_input", "Conflict query is outside the captured Artifact scope");
      }
      return boundResult;
    },
    compileCut: () => compileCut,
  });
}

function normalizeConflictQuery(value: unknown): ArtifactRiskConflictQuery {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifact", "hwCapabilityIds"])) {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Conflict query is invalid");
  }
  const artifact = parseArtifactRef(value.artifact);
  if (!Array.isArray(value.hwCapabilityIds)
    || value.hwCapabilityIds.length > MAX_CAPABILITY_IDS
    || value.hwCapabilityIds.some((id) => !boundedNeutralId(id))) {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Conflict capability scope is invalid");
  }
  const hwCapabilityIds = [...value.hwCapabilityIds] as string[];
  if (new Set(hwCapabilityIds).size !== hwCapabilityIds.length
    || !sameStringArray(hwCapabilityIds, [...hwCapabilityIds].sort(compareCodePoints))) {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Conflict capability scope is not canonical");
  }
  return { artifact, hwCapabilityIds };
}

function parseArtifactRef(value: unknown): ArtifactRef {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifactId", "revision", "contentHash"])) {
    throw new ArtifactCurrentConflictSourceError("invalid_input", "Only an exact ArtifactRef is accepted");
  }
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) throw new ArtifactCurrentConflictSourceError("invalid_input", "ArtifactRef is invalid");
  return Object.freeze({ ...parsed.data });
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
  return [...ids].sort(compareCodePoints);
}

function isRegistryEntry(value: unknown): value is ArtifactRegistryEntry {
  return isPlainObject(value)
    && hasExactKeys(value, ["artifact", "status", "tombstone", "audit"])
    && (value.status === "draft" || value.status === "superseded")
    && typeof value.tombstone === "boolean"
    && Array.isArray(value.audit);
}

function isCapabilitySnapshot(value: unknown): value is HomeWorldCapabilitySnapshot {
  return isPlainObject(value)
    && boundedNeutralId(value.hwCapabilityId)
    && boundedNeutralId(value.hwId)
    && boundedNeutralId(value.schema)
    && boundedNeutralId(value.schemaVersion)
    && (value.semanticKind === undefined || typeof value.semanticKind === "string")
    && Array.isArray(value.bindings);
}

function sameArtifactRef(left: ArtifactRevision | ArtifactRef, right: ArtifactRevision | ArtifactRef): boolean {
  return left.artifactId === right.artifactId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

function sameWatermark(left: unknown, right: HomeWorldWatermark): boolean {
  return isPlainObject(left)
    && left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq;
}

function sameSemanticWatermark(
  left: HomeWorldWatermark,
  right: ArtifactEvidenceAttestation["watermarks"][number],
): boolean {
  return left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq
    && right.freshness === "fresh"
    && right.gapCount === 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCatalogRules(left: CatalogRule, right: CatalogRule): number {
  return compareCodePoints(left.ruleRef, right.ruleRef)
    || compareCodePoints(left.name ?? "", right.name ?? "")
    || Number(left.enabled ?? false) - Number(right.enabled ?? false)
    || compareCodePoints(left.updatedAt ?? "", right.updatedAt ?? "");
}

function boundedNeutralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function freezeResult(value: ArtifactRiskConflictResult): ArtifactRiskConflictResult {
  const findings = value.findings.map((finding) => Object.freeze({ ...finding }));
  return Object.freeze({
    status: value.status,
    findings: Object.freeze(findings),
    sourceIdentity: value.sourceIdentity,
  });
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index]! < rightPoints[index]!) return -1;
    if (leftPoints[index]! > rightPoints[index]!) return 1;
  }
  return leftPoints.length - rightPoints.length;
}
