import { artifactRefSchema, type ArtifactRef } from "./artifact/neutral-artifact.js";
import type { AuthorityCandidateResolveInput } from "./authority/authority-candidate-registry.js";
import type {
  AuthorityBindingInputPort,
  AuthorityFreshWorldCut,
  AuthorityWorldWatermark,
} from "./artifact/artifact-authority-producer.js";
import type {
  HomeWorldCapabilitySnapshot,
  HomeWorldSnapshot,
  HomeWorldWatermark,
} from "./home-world-service.js";

const MAX_CAPABILITIES = 16;
const MAX_ID_BYTES = 200;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface HomeWorldAuthorityBindingSourcePort {
  snapshot(): HomeWorldSnapshot;
  resolveAuthorityCandidateInput(hwCapabilityId: string): AuthorityCandidateResolveInput | undefined;
  /**
   * Route availability is intentionally separate from configuration binding.
   * In particular, an unapproved configuration has no resolved route but must
   * still be assessable against its exact configured bridge watermark.
   */
  isActionAuthorityConfiguredForBridge(hwCapabilityId: string, bridgeId: string): boolean;
  resolveActionAuthority(hwCapabilityId: string): HomeWorldAuthoritySelection;
}

export interface HomeWorldAuthoritySelection {
  readonly status: "available" | "unavailable";
  readonly bridgeId?: string;
}

export interface HomeWorldAuthorityBindingSourceOptions {
  readonly homeWorld: HomeWorldAuthorityBindingSourcePort;
}

export type HomeWorldAuthorityBindingSourceErrorCode =
  | "invalid_input"
  | "unavailable"
  | "inconsistent_cut";

export class HomeWorldAuthorityBindingSourceError extends Error {
  constructor(
    readonly code: HomeWorldAuthorityBindingSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HomeWorldAuthorityBindingSourceError";
  }
}

interface TargetCut {
  readonly hwCapabilityId: string;
  readonly resolveInput: AuthorityCandidateResolveInput;
  readonly watermarkBridgeIds: readonly string[];
  readonly fingerprint: Readonly<Record<string, unknown>>;
}

interface CollectedCut {
  readonly capturedAt: string;
  readonly watermarks: readonly AuthorityWorldWatermark[];
  readonly bindings: readonly TargetCut[];
  readonly fingerprint: string;
}

/**
 * Unmounted, synchronous HomeWorld source for Hub authority assessment.
 * It reads only neutral snapshots and Hub-private selectors; it owns no
 * bridge, control, credential, or execution capability.
 */
export class HomeWorldAuthorityBindingSource implements AuthorityBindingInputPort {
  private readonly homeWorld: HomeWorldAuthorityBindingSourcePort;

  constructor(options: HomeWorldAuthorityBindingSourceOptions) {
    if (!options
      || typeof options !== "object"
      || !options.homeWorld
      || typeof options.homeWorld.snapshot !== "function"
      || typeof options.homeWorld.resolveAuthorityCandidateInput !== "function"
      || typeof options.homeWorld.isActionAuthorityConfiguredForBridge !== "function"
      || typeof options.homeWorld.resolveActionAuthority !== "function") {
      throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld authority source is invalid");
    }
    this.homeWorld = options.homeWorld;
  }

  readFreshWorldCut(input: {
    readonly artifact: ArtifactRef;
    readonly hwCapabilityIds: readonly string[];
  }): AuthorityFreshWorldCut {
    const targets = normalizeRequest(input);
    let firstSnapshot: HomeWorldSnapshot;
    try {
      firstSnapshot = this.homeWorld.snapshot();
    } catch {
      throw unavailable("HomeWorld snapshot is unavailable");
    }
    const firstCapturedAt = normalizeCapturedAt(firstSnapshot);

    // Notify-only artifacts deliberately do not require any bridge watermark.
    if (targets.length === 0) {
      return freezeCut({ capturedAt: firstCapturedAt, watermarks: [], bindings: [] });
    }

    const first = this.collect(firstSnapshot, targets);
    let secondSnapshot: HomeWorldSnapshot;
    try {
      secondSnapshot = this.homeWorld.snapshot();
    } catch {
      throw new HomeWorldAuthorityBindingSourceError("inconsistent_cut", "HomeWorld changed during authority read");
    }
    const second = this.collect(secondSnapshot, targets);
    if (first.fingerprint !== second.fingerprint) {
      throw new HomeWorldAuthorityBindingSourceError("inconsistent_cut", "HomeWorld changed during authority read");
    }

    return freezeCut({
      capturedAt: first.capturedAt,
      watermarks: first.watermarks,
      bindings: first.bindings.map((binding) => ({
        hwCapabilityId: binding.hwCapabilityId,
        resolveInput: binding.resolveInput,
        watermarkBridgeIds: binding.watermarkBridgeIds,
      })),
    });
  }

  private collect(snapshot: HomeWorldSnapshot, targets: readonly string[]): CollectedCut {
    const capturedAt = normalizeCapturedAt(snapshot);
    const targetCuts = targets.map((target) => this.collectTarget(snapshot, target));
    const bridgeIds = [...new Set(targetCuts.flatMap((target) => target.watermarkBridgeIds))].sort(compareStrings);
    if (bridgeIds.length === 0) throw unavailable("Authority target has no bound bridge");
    const watermarks = bridgeIds.map((bridgeId) => readFreshWatermark(snapshot, bridgeId));
    const fingerprint = canonicalJson({
      capturedAt,
      targets: targetCuts
        .map((target) => target.fingerprint)
        .sort((left, right) => compareStrings(String(left.hwCapabilityId), String(right.hwCapabilityId))),
      watermarks,
    });
    return { capturedAt, watermarks, bindings: targetCuts, fingerprint };
  }

  private collectTarget(snapshot: HomeWorldSnapshot, hwCapabilityId: string): TargetCut {
    const capabilities = findCapabilities(snapshot, hwCapabilityId);
    const rawInput = this.homeWorld.resolveAuthorityCandidateInput(hwCapabilityId);
    if (rawInput === undefined) throw unavailable("Authority capability is unavailable");
    const resolveInput = normalizeResolveInput(rawInput, hwCapabilityId);
    const capabilityBindings = normalizeCapabilityBindings(capabilities, hwCapabilityId);

    if (!resolveInput.configured) {
      if (capabilityBindings.length === 0) throw unavailable("Authority capability has no bindings");
      const watermarkBridgeIds = [...new Set(capabilityBindings.map((binding) => binding.bridgeId))].sort(compareStrings);
      return {
        hwCapabilityId,
        resolveInput,
        watermarkBridgeIds,
        fingerprint: {
          hwCapabilityId,
          resolveInput,
          selectedBridgeId: null,
          capabilityBindings,
          watermarkBridgeIds,
        },
      };
    }

    const configured = capabilityBindings.filter((binding) => {
      try {
        return this.homeWorld.isActionAuthorityConfiguredForBridge(hwCapabilityId, binding.bridgeId);
      } catch {
        throw unavailable("Configured authority is unavailable");
      }
    });
    if (configured.length !== 1) throw unavailable("Configured authority binding is ambiguous");
    const selectedBridgeId = configured[0]!.bridgeId;

    // An unapproved authority has no route by design. Keep the exact
    // configuration binding so the candidate can become `not_approved`
    // without accidentally widening its evidence scope to every bridge.
    if (!resolveInput.approved) {
      if (resolveInput.available) throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Unapproved authority cannot be available");
      const watermarkBridgeIds = [selectedBridgeId];
      return {
        hwCapabilityId,
        resolveInput,
        watermarkBridgeIds,
        fingerprint: {
          hwCapabilityId,
          resolveInput,
          selectedBridgeId,
          capabilityBindings,
          watermarkBridgeIds,
        },
      };
    }

    let selection: HomeWorldAuthoritySelection;
    try {
      selection = this.homeWorld.resolveActionAuthority(hwCapabilityId);
    } catch {
      throw unavailable("Configured authority is unavailable");
    }
    if (selection.status !== "available"
      || selection.bridgeId !== selectedBridgeId
      || !resolveInput.available) {
      throw unavailable("Configured authority is unavailable");
    }
    const watermarkBridgeIds = [selectedBridgeId];
    return {
      hwCapabilityId,
      resolveInput,
      watermarkBridgeIds,
      fingerprint: {
        hwCapabilityId,
        resolveInput,
        selectedBridgeId,
        capabilityBindings,
        watermarkBridgeIds,
      },
    };
  }
}

function normalizeRequest(input: unknown): string[] {
  if (!isPlainObject(input) || !hasExactKeys(input, ["artifact", "hwCapabilityIds"])
    || !artifactRefSchema.safeParse(input.artifact).success
    || !Array.isArray(input.hwCapabilityIds)
    || input.hwCapabilityIds.length > MAX_CAPABILITIES) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Authority world-cut request is invalid");
  }
  const targets = input.hwCapabilityIds.map((value) => boundedId(value));
  if (new Set(targets).size !== targets.length) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Authority world-cut targets are duplicated");
  }
  return targets.sort(compareStrings);
}

function normalizeResolveInput(value: unknown, expectedHwCapabilityId: string): AuthorityCandidateResolveInput {
  if (!isPlainObject(value)
    || typeof value.hwCapabilityId !== "string"
    || value.hwCapabilityId !== expectedHwCapabilityId
    || value.knownCapability !== true
    || typeof value.configured !== "boolean"
    || typeof value.approved !== "boolean"
    || typeof value.available !== "boolean") {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Authority candidate input is invalid");
  }
  if (!value.configured) {
    if (!hasExactKeys(value, ["hwCapabilityId", "knownCapability", "configured", "approved", "available"])
      || value.approved || value.available) {
      throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Authority placeholder input is invalid");
    }
    return Object.freeze({
      hwCapabilityId: expectedHwCapabilityId,
      knownCapability: true,
      configured: false,
      approved: false,
      available: false,
    });
  }
  if (!hasExactKeys(value, [
    "hwCapabilityId", "knownCapability", "configured", "approved", "available",
    "bindingIdentity", "configurationIdentity", "registrationGeneration",
  ])
    || typeof value.bindingIdentity !== "string"
    || !SHA256.test(value.bindingIdentity)
    || typeof value.configurationIdentity !== "string"
    || !SHA256.test(value.configurationIdentity)
    || typeof value.registrationGeneration !== "number"
    || !Number.isSafeInteger(value.registrationGeneration)
    || value.registrationGeneration < 1) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Configured authority input is invalid");
  }
  return Object.freeze({
    hwCapabilityId: expectedHwCapabilityId,
    knownCapability: true,
    configured: true,
    approved: value.approved,
    available: value.available,
    bindingIdentity: value.bindingIdentity,
    configurationIdentity: value.configurationIdentity,
    registrationGeneration: value.registrationGeneration,
  });
}

function findCapabilities(snapshot: HomeWorldSnapshot, hwCapabilityId: string): readonly HomeWorldCapabilitySnapshot[] {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.devices)) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld snapshot is invalid");
  }
  const matches: HomeWorldCapabilitySnapshot[] = [];
  for (const device of snapshot.devices) {
    if (!isPlainObject(device) || !Array.isArray(device.capabilities)) {
      throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld device snapshot is invalid");
    }
    for (const capability of device.capabilities) {
      if (!isPlainObject(capability)) {
        throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld capability snapshot is invalid");
      }
      if (capability.hwCapabilityId !== hwCapabilityId) continue;
      if (!isCapabilitySnapshot(capability)) {
        throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld capability snapshot is invalid");
      }
      matches.push(capability);
    }
  }
  if (matches.length === 0) throw unavailable("Authority capability is missing or unavailable");
  return matches;
}

function isCapabilitySnapshot(value: unknown): value is HomeWorldCapabilitySnapshot {
  if (!isPlainObject(value)) return false;
  return typeof value.hwCapabilityId === "string"
    && typeof value.hwId === "string"
    && typeof value.schema === "string"
    && typeof value.schemaVersion === "string"
    && (value.semanticKind === undefined || typeof value.semanticKind === "string")
    && Array.isArray(value.bindings);
}

function normalizeCapabilityBindings(
  capabilities: readonly HomeWorldCapabilitySnapshot[],
  expectedHwCapabilityId: string,
): readonly {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly hwSpaceId?: string;
}[] {
  const [first] = capabilities;
  if (first === undefined) throw unavailable("Authority capability has no bindings");
  if (first.hwCapabilityId !== expectedHwCapabilityId) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld capability identity is invalid");
  }
  if (typeof first.hwId !== "string" || typeof first.schema !== "string" || typeof first.schemaVersion !== "string"
    || (first.semanticKind !== undefined && typeof first.semanticKind !== "string")) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld capability identity is invalid");
  }

  const byRoute = new Map<string, {
    readonly bridgeId: string;
    readonly nativeId: string;
    readonly nativeInstanceId: string;
    readonly hwSpaceId?: string;
  }>();
  for (const capability of capabilities) {
    if (!isPlainObject(capability)
      || capability.hwCapabilityId !== expectedHwCapabilityId
      || capability.hwId !== first.hwId
      || capability.schema !== first.schema
      || capability.schemaVersion !== first.schemaVersion
      || capability.semanticKind !== first.semanticKind
      || !Array.isArray(capability.bindings)) {
      throw unavailable("Authority capability identity is inconsistent");
    }
    for (const binding of capability.bindings) {
      if (!isPlainObject(binding)) {
        throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld capability binding is invalid");
      }
      const normalized = {
        bridgeId: boundedId(binding.bridgeId),
        nativeId: boundedId(binding.nativeId),
        nativeInstanceId: boundedId(binding.nativeInstanceId),
        ...(binding.hwSpaceId === undefined ? {} : { hwSpaceId: boundedId(binding.hwSpaceId) }),
      };
      const routeKey = canonicalJson([normalized.bridgeId, normalized.nativeId, normalized.nativeInstanceId]);
      const existing = byRoute.get(routeKey);
      if (existing !== undefined) {
        if ((existing.hwSpaceId ?? null) !== (normalized.hwSpaceId ?? null)) {
          throw unavailable("Authority capability binding is inconsistent");
        }
        continue;
      }
      byRoute.set(routeKey, normalized);
    }
  }
  const bindings = [...byRoute.values()];
  if (bindings.length === 0) throw unavailable("Authority capability has no bindings");
  return bindings.sort((left, right) => compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.nativeId, right.nativeId)
    || compareStrings(left.nativeInstanceId, right.nativeInstanceId));
}

function readFreshWatermark(snapshot: HomeWorldSnapshot, bridgeId: string): AuthorityWorldWatermark {
  const bridge = snapshot.bridges?.[bridgeId];
  if (bridge === undefined || bridge.watermark === null || bridge.watermark === undefined) {
    throw unavailable("Relevant bridge watermark is missing");
  }
  if (!isPlainObject(bridge) || bridge.bridgeId !== bridgeId || !isPlainObject(bridge.diagnostics) || !isPlainObject(bridge.metrics)) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Relevant bridge snapshot is invalid");
  }
  const diagnostics = bridge.diagnostics;
  const gapCount = diagnostics?.historyGapCount;
  if (!Number.isSafeInteger(gapCount) || gapCount < 0 || gapCount !== 0) {
    throw unavailable("Relevant bridge watermark has a history gap");
  }
  if (Array.isArray(diagnostics.recentHistoryGaps) && diagnostics.recentHistoryGaps.length > 0) {
    throw unavailable("Relevant bridge watermark has a history gap");
  }
  const freshness = bridge.metrics?.consistency === "ready"
    && bridge.metrics.connection === "up"
    && diagnostics.connectionState === "ready"
    ? "fresh" as const
    : "stale" as const;
  if (freshness !== "fresh") throw unavailable("Relevant bridge watermark is stale");
  return normalizeWatermark(bridge.watermark, bridgeId, freshness, gapCount);
}

function normalizeWatermark(
  value: HomeWorldWatermark,
  expectedBridgeId: string,
  freshness: "fresh" | "stale" | "unknown",
  gapCount: number,
): AuthorityWorldWatermark {
  if (!isPlainObject(value)
    || value.bridgeId !== expectedBridgeId
    || boundedId(value.bridgeId) === ""
    || boundedId(value.epochId) === ""
    || !Number.isSafeInteger(value.lastSeq)
    || value.lastSeq < 0
    || (value.lastSyncCompleteAt !== undefined && normalizeCapturedAtValue(value.lastSyncCompleteAt) === undefined)) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld watermark is invalid");
  }
  return {
    bridgeId: value.bridgeId,
    epochId: value.epochId,
    lastSeq: value.lastSeq,
    ...(value.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: value.lastSyncCompleteAt }),
    freshness,
    gapCount,
  };
}

function normalizeCapturedAt(snapshot: HomeWorldSnapshot): string {
  if (!snapshot || typeof snapshot.generatedAt !== "string") {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld snapshot timestamp is invalid");
  }
  const value = normalizeCapturedAtValue(snapshot.generatedAt);
  if (value === undefined) throw new HomeWorldAuthorityBindingSourceError("invalid_input", "HomeWorld snapshot timestamp is invalid");
  return value;
}

function normalizeCapturedAtValue(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function freezeCut(cut: AuthorityFreshWorldCut): AuthorityFreshWorldCut {
  return Object.freeze({
    capturedAt: cut.capturedAt,
    watermarks: Object.freeze(cut.watermarks.map((watermark) => Object.freeze({ ...watermark }))),
    bindings: Object.freeze(cut.bindings.map((binding) => Object.freeze({
      hwCapabilityId: binding.hwCapabilityId,
      resolveInput: Object.freeze({ ...binding.resolveInput }),
      watermarkBridgeIds: Object.freeze([...binding.watermarkBridgeIds]),
    }))),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareStrings).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    throw new HomeWorldAuthorityBindingSourceError("invalid_input", "Hub identifier is invalid");
  }
  return value;
}

function unavailable(message: string): HomeWorldAuthorityBindingSourceError {
  return new HomeWorldAuthorityBindingSourceError("unavailable", message);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
