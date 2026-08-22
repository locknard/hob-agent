import { createHash } from "node:crypto";

import {
  artifactAuthorityCandidateSchema,
  artifactWatermarkSchema,
  canonicalAssessmentInput,
  createArtifactAuthorityAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactAuthorityInput,
  type ArtifactRef,
} from "./artifact-assessments.js";
import {
  artifactRefSchema,
  parseArtifactRevision,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import {
  type ArtifactAssessmentEntry,
  type ArtifactRegistryEntry,
} from "./artifact-registry.js";
import {
  type AuthorityCandidateResolution,
  type AuthorityCandidateResolutionPort,
  type AuthorityCandidateResolveInput,
} from "../authority/authority-candidate-port.js";

export type AuthorityWorldWatermark = ArtifactAuthorityInput["checkedWatermarks"][number];

/** Hub-private binding material; it contains no bridge/native route fields. */
export interface AuthorityBindingInput {
  readonly hwCapabilityId: string;
  readonly resolveInput: AuthorityCandidateResolveInput;
  readonly watermarkBridgeIds: readonly string[];
}

/** Fresh, source-owned world cut returned by the Hub binding seam. */
export interface AuthorityFreshWorldCut {
  readonly capturedAt: string;
  readonly watermarks: readonly AuthorityWorldWatermark[];
  readonly bindings: readonly AuthorityBindingInput[];
}

/**
 * Hub-private seam for obtaining current binding inputs and committed
 * watermarks. The caller cannot supply candidate or watermark values to the
 * producer; they are read from this source after the immutable artifact is
 * reloaded.
 */
export interface AuthorityBindingInputPort {
  readFreshWorldCut(input: {
    readonly artifact: ArtifactRef;
    readonly hwCapabilityIds: readonly string[];
  }): AuthorityFreshWorldCut;
}

/** Narrow artifact registry port; no revision or assessment mutation besides the one write. */
export interface ArtifactAuthorityRegistryPort {
  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined;
  recordAuthorityAssessment(input: {
    readonly assessment: ArtifactAuthorityAssessment;
    readonly idempotencyKey: string;
    readonly actor?: string;
  }): ArtifactAssessmentEntry;
}

export interface ArtifactAuthorityProducerOptions {
  readonly artifacts: ArtifactAuthorityRegistryPort;
  readonly authority: AuthorityCandidateResolutionPort;
  readonly bindingInput: AuthorityBindingInputPort;
}

export type ArtifactAuthorityProducerErrorCode =
  | "invalid_input"
  | "artifact_not_found"
  | "invalid_world_cut"
  | "authority_unavailable"
  | "assessment_write_failed";

export class ArtifactAuthorityProducerError extends Error {
  constructor(
    readonly code: ArtifactAuthorityProducerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactAuthorityProducerError";
  }
}

const PRODUCER_VERSION = "artifact-authority-producer-v1";
const PRODUCER_ACTOR = "hub-authority-producer";
const MAX_ID_BYTES = 200;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

/**
 * Hub-only authority assessment producer. It accepts an ArtifactRef, reloads
 * the immutable artifact, reads one fresh world cut, resolves each device
 * target through the private candidate registry, and persists one immutable
 * authority assessment. It is intentionally unmounted and has no bridge or
 * control capability.
 */
export class ArtifactAuthorityProducer {
  private readonly artifacts: ArtifactAuthorityRegistryPort;
  private readonly authority: ArtifactAuthorityProducerOptions["authority"];
  private readonly bindingInput: AuthorityBindingInputPort;

  constructor(options: ArtifactAuthorityProducerOptions) {
    if (options === null || typeof options !== "object") {
      throw new ArtifactAuthorityProducerError("invalid_input", "Artifact authority producer options are invalid");
    }
    if (!options.artifacts
      || typeof options.artifacts.getRevision !== "function"
      || typeof options.artifacts.recordAuthorityAssessment !== "function") {
      throw new ArtifactAuthorityProducerError("invalid_input", "Artifact authority registry seam is required");
    }
    if (!options.authority || typeof options.authority.resolve !== "function") {
      throw new ArtifactAuthorityProducerError("invalid_input", "Authority candidate registry seam is required");
    }
    if (!options.bindingInput || typeof options.bindingInput.readFreshWorldCut !== "function") {
      throw new ArtifactAuthorityProducerError("invalid_input", "Fresh world-cut binding seam is required");
    }
    this.artifacts = options.artifacts;
    this.authority = options.authority;
    this.bindingInput = options.bindingInput;
  }

  /** Produce and durably record the current authority assessment for one ref. */
  produce(input: ArtifactRef): ArtifactAssessmentEntry {
    const requestedRef = validateArtifactRef(input);
    const entry = this.readArtifact(requestedRef);
    let artifact: ArtifactRevision;
    try {
      artifact = parseArtifactRevision(entry.artifact);
    } catch {
      throw new ArtifactAuthorityProducerError("artifact_not_found", "Artifact revision is unavailable");
    }
    const targets = extractDeviceTargets(artifact);

    let worldCut: AuthorityFreshWorldCut;
    try {
      worldCut = this.bindingInput.readFreshWorldCut({
        artifact: requestedRef,
        hwCapabilityIds: targets,
      });
    } catch {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut is unavailable");
    }

    const normalizedCut = normalizeWorldCut(worldCut, targets);
    const resolutions = resolveTargets(this.authority, normalizedCut, targets);
    const candidates = resolutions.map((resolution) => resolution.candidate);
    const scopedRegistryIdentities = resolutions
      .map((resolution) => ({
        hwCapabilityId: resolution.candidate.hwCapabilityId,
        authorityRegistryIdentity: resolution.authorityRegistryIdentity,
      }))
      .sort((left, right) => left.hwCapabilityId.localeCompare(right.hwCapabilityId));
    const authorityRegistryIdentity = digest("authority-registry-scope", scopedRegistryIdentities);
    const assessmentId = `authority-${digest("assessment-id", {
      artifact: requestedRef,
      scopedRegistryIdentities,
      candidates,
      checkedWatermarks: normalizedCut.checkedWatermarks,
      capturedAt: normalizedCut.capturedAt,
    }).slice("sha256:".length)}`;
    const assessedAt = normalizedCut.capturedAt;
    let assessment: ArtifactAuthorityAssessment;
    try {
      assessment = createArtifactAuthorityAssessment({
        artifact: requestedRef,
        assessmentId,
        assessedAt,
        authorityRegistryIdentity,
        candidates,
        checkedWatermarks: [...normalizedCut.checkedWatermarks],
      }, { hwCapabilityIds: targets });
    } catch {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Authority assessment inputs are invalid");
    }

    try {
      return this.artifacts.recordAuthorityAssessment({
        assessment,
        idempotencyKey: `${PRODUCER_VERSION}-${assessment.inputIdentity.slice("sha256:".length)}-${digest("capture", assessedAt).slice("sha256:".length)}`,
        actor: PRODUCER_ACTOR,
      });
    } catch {
      throw new ArtifactAuthorityProducerError("assessment_write_failed", "Authority assessment could not be persisted");
    }
  }

  private readArtifact(requestedRef: ArtifactRef): ArtifactRegistryEntry {
    let entry: ArtifactRegistryEntry | undefined;
    try {
      entry = this.artifacts.getRevision(requestedRef.artifactId, requestedRef.revision);
    } catch {
      throw new ArtifactAuthorityProducerError("artifact_not_found", "Artifact revision is unavailable");
    }
    if (entry === undefined
      || entry.status !== "draft"
      || entry.artifact.artifactId !== requestedRef.artifactId
      || entry.artifact.revision !== requestedRef.revision
      || entry.artifact.contentHash !== requestedRef.contentHash) {
      throw new ArtifactAuthorityProducerError("artifact_not_found", "Artifact revision is unavailable");
    }
    return entry;
  }
}

function validateArtifactRef(value: unknown): ArtifactRef {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifactId", "revision", "contentHash"])) {
    throw new ArtifactAuthorityProducerError("invalid_input", "Only an ArtifactRef is accepted");
  }
  const parsed = artifactRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactAuthorityProducerError("invalid_input", "ArtifactRef is invalid");
  }
  return parsed.data;
}

function extractDeviceTargets(artifact: ArtifactRevision): string[] {
  const targets = new Set<string>();
  for (const action of artifact.content.actions) {
    if (action.kind !== "notify_local") targets.add(action.target.hwCapabilityId);
  }
  return [...targets].sort(compareStrings);
}

function normalizeWorldCut(
  value: unknown,
  targets: readonly string[],
): {
  readonly capturedAt: string;
  readonly checkedWatermarks: readonly AuthorityWorldWatermark[];
  readonly bindings: readonly AuthorityBindingInput[];
} {
  if (!isPlainObject(value) || !hasExactKeys(value, ["capturedAt", "watermarks", "bindings"])
    || typeof value.capturedAt !== "string"
    || !Array.isArray(value.watermarks) || !Array.isArray(value.bindings)) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut is invalid");
  }
  const capturedAt = normalizeTime(value.capturedAt, "invalid_world_cut");

  if (value.watermarks.length > 16 || value.bindings.length > 16) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut budget is exceeded");
  }

  const watermarks: AuthorityWorldWatermark[] = [];
  const watermarkByBridge = new Map<string, AuthorityWorldWatermark>();
  for (const raw of value.watermarks) {
    const parsed = artifactWatermarkSchema.safeParse(raw);
    if (!parsed.success || parsed.data.freshness !== "fresh" || parsed.data.gapCount !== 0
      || watermarkByBridge.has(parsed.success ? parsed.data.bridgeId : "")) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut watermark is invalid");
    }
    watermarkByBridge.set(parsed.data.bridgeId, parsed.data);
    watermarks.push(parsed.data);
  }
  if (watermarks.length > 16) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut watermark budget is exceeded");
  }

  const bindings: AuthorityBindingInput[] = [];
  const bindingByCapability = new Map<string, AuthorityBindingInput>();
  for (const raw of value.bindings) {
    if (!isPlainObject(raw) || !hasExactKeys(raw, ["hwCapabilityId", "resolveInput", "watermarkBridgeIds"])
      || typeof raw.hwCapabilityId !== "string"
      || !Array.isArray(raw.watermarkBridgeIds)
      || !isPlainObject(raw.resolveInput)
      || bindingByCapability.has(raw.hwCapabilityId)) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut binding is invalid");
    }
    const bridgeIds = raw.watermarkBridgeIds;
    if (bridgeIds.length === 0 || bridgeIds.length > 16 || bridgeIds.some((bridgeId) => (
      typeof bridgeId !== "string"
      || bridgeId.length === 0
      || bridgeId.trim() !== bridgeId
      || Buffer.byteLength(bridgeId, "utf8") > MAX_ID_BYTES
      || !watermarkByBridge.has(bridgeId)
    ))) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut binding watermark is invalid");
    }
    if ((raw.resolveInput as Record<string, unknown>).hwCapabilityId !== raw.hwCapabilityId) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut capability binding is inconsistent");
    }
    const binding = {
      hwCapabilityId: raw.hwCapabilityId,
      resolveInput: raw.resolveInput as unknown as AuthorityCandidateResolveInput,
      watermarkBridgeIds: [...new Set(bridgeIds)] as string[],
    } satisfies AuthorityBindingInput;
    validateResolveInput(binding.resolveInput, binding.hwCapabilityId);
    if (binding.watermarkBridgeIds.length !== bridgeIds.length) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut binding watermarks are duplicated");
    }
    bindingByCapability.set(binding.hwCapabilityId, binding);
    bindings.push(binding);
  }
  if (bindings.length !== targets.length || targets.some((target) => !bindingByCapability.has(target))) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut does not cover artifact targets");
  }

  const checkedBridgeIds = targets.length === 0
    ? [...watermarkByBridge.keys()]
    : [...new Set(targets.flatMap((target) => bindingByCapability.get(target)!.watermarkBridgeIds))];
  const checkedWatermarks = checkedBridgeIds
    .map((bridgeId) => watermarkByBridge.get(bridgeId))
    .filter((watermark): watermark is AuthorityWorldWatermark => watermark !== undefined)
    .sort((left, right) => compareStrings(left.bridgeId, right.bridgeId));
  if (checkedWatermarks.length !== checkedBridgeIds.length) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut watermark scope is incomplete");
  }
  return {
    capturedAt,
    checkedWatermarks,
    bindings: targets.map((target) => bindingByCapability.get(target)!).sort((left, right) => compareStrings(left.hwCapabilityId, right.hwCapabilityId)),
  };
}

function resolveTargets(
  authority: ArtifactAuthorityProducerOptions["authority"],
  cut: { readonly bindings: readonly AuthorityBindingInput[] },
  targets: readonly string[],
): readonly AuthorityCandidateResolution[] {
  const byCapability = new Map(cut.bindings.map((binding) => [binding.hwCapabilityId, binding] as const));
  const resolutions: AuthorityCandidateResolution[] = [];
  for (const target of targets) {
    const binding = byCapability.get(target);
    if (binding === undefined) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Authority target binding is missing");
    }
    let resolution: AuthorityCandidateResolution;
    try {
      resolution = authority.resolve(binding.resolveInput);
    } catch {
      throw new ArtifactAuthorityProducerError("authority_unavailable", "Authority candidate is unavailable");
    }
    if (!isPlainObject(resolution)
      || !hasExactKeys(resolution, ["authorityRegistryIdentity", "candidate"])
      || !SHA256.test(resolution.authorityRegistryIdentity)
      || !isPlainObject(resolution.candidate)
      || !artifactAuthorityCandidateSchema.safeParse(resolution.candidate).success
      || resolution.candidate.hwCapabilityId !== target) {
      throw new ArtifactAuthorityProducerError("authority_unavailable", "Authority candidate projection is invalid");
    }
    resolutions.push(resolution);
  }
  return resolutions;
}

function validateResolveInput(value: AuthorityCandidateResolveInput, expectedCapabilityId: string): void {
  if (!isPlainObject(value)
    || typeof value.hwCapabilityId !== "string"
    || value.hwCapabilityId !== expectedCapabilityId
    || typeof value.knownCapability !== "boolean"
    || typeof value.configured !== "boolean"
    || typeof value.approved !== "boolean"
    || typeof value.available !== "boolean") {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut authority input is invalid");
  }
  const keys = Reflect.ownKeys(value);
  const baseKeys = ["hwCapabilityId", "knownCapability", "configured", "approved", "available"];
  if (!value.configured) {
    if (!hasExactKeys(value, baseKeys) || value.approved || value.available) {
      throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut authority input is invalid");
    }
    return;
  }
  const configuredKeys = [...baseKeys, "bindingIdentity", "configurationIdentity", "registrationGeneration"];
  if (!hasExactKeys(value, configuredKeys)
    || typeof value.bindingIdentity !== "string"
    || typeof value.configurationIdentity !== "string"
    || !SHA256.test(value.bindingIdentity)
    || !SHA256.test(value.configurationIdentity)
    || typeof value.registrationGeneration !== "number"
    || !Number.isSafeInteger(value.registrationGeneration)
    || value.registrationGeneration < 1
    || keys.length !== configuredKeys.length) {
    throw new ArtifactAuthorityProducerError("invalid_world_cut", "Fresh world cut authority input is invalid");
  }
}

function digest(kind: string, input: unknown): `sha256:${string}` {
  const canonical = canonicalAssessmentInput({ kind, input });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function normalizeTime(
  value: unknown,
  code: ArtifactAuthorityProducerErrorCode = "invalid_input",
): string {
  if (typeof value !== "string") {
    throw new ArtifactAuthorityProducerError(code, "Fresh world cut timestamp is invalid");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ArtifactAuthorityProducerError(code, "Fresh world cut timestamp is invalid");
  }
  return date.toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}
