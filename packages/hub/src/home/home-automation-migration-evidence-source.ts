import { createHash } from "node:crypto";

import {
  foreignRuleSummarySchema,
  type BridgeActionTarget,
} from "@hob/bridge-contract";

import {
  createForeignRuleArtifactCandidate,
  type ForeignRuleArtifactCandidate,
} from "../artifact/foreign-rule-artifact-candidate.js";
import { parseArtifactContent, type ArtifactContent } from "../artifact/neutral-artifact.js";
import type {
  HomeWorldEvidenceQuery,
  HomeWorldEvidenceResult,
  HomeWorldForeignRuleCatalog,
  HomeWorldForeignRuleMigrationInput,
} from "../world/home-world-service.js";
import type {
  HomeAutomationMigrationExistingRuleAction,
  HomeAutomationMigrationExistingRuleSummary,
  HomeAutomationMigrationExistingRuleTrigger,
  HomeAutomationMigrationSimulationEvent,
  HomeAutomationMigrationSimulationEvidencePort,
  HomeAutomationMigrationSimulationSourceCut,
} from "./home-automation-migration-simulation.js";

const LOOKBACK_HOURS = 168;
const EVIDENCE_LIMIT = 32;
const MAX_CATALOG_RULES = 64;
const MAX_CATALOGS = 64;
const MAX_ID_LENGTH = 256;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_SCALAR_STRING_BYTES = 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * The read-only HomeWorld seam required by migration dual-run evidence.
 * Nothing on this port can execute a rule or write a bridge.
 */
export interface HomeAutomationMigrationEvidenceHomeWorldPort {
  foreignRuleCatalog(): Promise<readonly HomeWorldForeignRuleCatalog[]>;
  translateForeignRule(input: HomeWorldForeignRuleMigrationInput): Promise<unknown>;
  resolveBridgeActionTargetForBinding(input: unknown): BridgeActionTarget | undefined;
  queryRecentEvidence(input: HomeWorldEvidenceQuery): HomeWorldEvidenceResult | Promise<HomeWorldEvidenceResult>;
}

/**
 * Converts one stable HomeWorld cut into the bounded neutral evidence consumed
 * by the migration simulator. Two exact catalog reads fence the bounded
 * translation and evidence capture. Any incomplete input or cut drift closes
 * the operation without producing simulation evidence.
 */
export class HomeAutomationMigrationSimulationEvidenceSource implements HomeAutomationMigrationSimulationEvidencePort {
  constructor(private readonly world: HomeAutomationMigrationEvidenceHomeWorldPort) {}

  async read(input: Parameters<HomeAutomationMigrationSimulationEvidencePort["read"]>[0]): Promise<Awaited<ReturnType<HomeAutomationMigrationSimulationEvidencePort["read"]>>> {
    try {
      const request = parseRequest(input);
      if (request === undefined || request.signal.aborted) return undefined;

      const before = parseCatalogSet(await this.world.foreignRuleCatalog());
      if (before === undefined || request.signal.aborted) return undefined;
      const catalog = selectSourceCatalog(before, request.sourceCut);
      if (catalog === undefined) return undefined;
      if (catalog.rules.filter((rule) => rule.ruleRef === request.candidate.ruleRef).length !== 1) {
        return undefined;
      }
      if (request.candidate.content.trigger.kind === "schedule") return undefined;

      const existingRuleSummaries: HomeAutomationMigrationExistingRuleSummary[] = [];
      for (const rule of catalog.rules) {
        if (rule.ruleRef === request.candidate.ruleRef) continue;
        if (request.signal.aborted) return undefined;

        const translated = await this.world.translateForeignRule({
          bridgeId: request.sourceCut.bridgeId,
          epochId: request.sourceCut.epochId,
          lastSeq: request.sourceCut.lastSeq,
          ruleRef: rule.ruleRef,
          signal: request.signal,
        });
        if (request.signal.aborted) return undefined;

        const mapped = createForeignRuleArtifactCandidate(
          translated,
          (binding) => binding.bridgeId === request.sourceCut.bridgeId
            ? this.world.resolveBridgeActionTargetForBinding(binding)
            : undefined,
        );
        if (mapped.status !== "candidate"
          || mapped.ruleRef !== rule.ruleRef) {
          return undefined;
        }
        const summary = mapExistingRule(rule, mapped);
        if (summary === undefined) return undefined;
        existingRuleSummaries.push(summary);
      }

      const capabilityIds = capabilityIdsForCandidate(request.candidate.content);
      const evidence = await this.world.queryRecentEvidence({
        hwCapabilityIds: capabilityIds,
        lookbackHours: LOOKBACK_HOURS,
        limit: EVIDENCE_LIMIT,
      });
      if (request.signal.aborted) return undefined;
      const parsedEvidence = parseEvidenceResult(evidence, request.sourceCut, capabilityIds);
      if (parsedEvidence === undefined) return undefined;
      const eventSamples = mapCapabilityChangedEvents(
        parsedEvidence,
        request.candidate.content.trigger.source.hwCapabilityId,
        capabilityIds,
      );
      if (eventSamples.length === 0) return undefined;

      const after = parseCatalogSet(await this.world.foreignRuleCatalog());
      if (after === undefined || request.signal.aborted) return undefined;
      const afterCatalog = selectSourceCatalog(after, request.sourceCut);
      if (afterCatalog === undefined || !sameCatalogCut(catalog, afterCatalog)) return undefined;

      return Object.freeze({
        sourceCut: request.sourceCut,
        eventSamples: Object.freeze([...eventSamples]),
        existingRuleSummaries: Object.freeze([...existingRuleSummaries]),
      });
    } catch {
      return undefined;
    }
  }
}

/** Short alias for callers that name the implementation after its source. */
export const HomeAutomationMigrationEvidenceSource = HomeAutomationMigrationSimulationEvidenceSource;

interface ParsedRequest {
  readonly sourceCut: HomeAutomationMigrationSimulationSourceCut;
  readonly candidate: ForeignRuleArtifactCandidate;
  readonly signal: AbortSignal;
}

interface ParsedCatalog {
  readonly bridgeId: string;
  readonly status: "available" | "unavailable";
  readonly epochId?: string;
  readonly lastSeq?: number;
  readonly rules: readonly ParsedRuleSummary[];
}

interface ParsedRuleSummary {
  readonly ruleRef: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly updatedAt?: string;
}

interface ParsedEvidence {
  readonly events: readonly ParsedEvidenceEvent[];
}

interface ParsedEvidenceEvent {
  readonly capabilityId: string;
  readonly value: string | number | boolean | null;
  readonly observedAt: string;
  readonly provenance: {
    readonly bridgeId: string;
    readonly epochId: string;
    readonly seq: number;
  };
}

function parseRequest(value: unknown): ParsedRequest | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["sourceCut", "candidate", "signal"])) return undefined;
    const sourceCut = parseSourceCut(value.sourceCut);
    const candidate = parseCandidate(value.candidate);
    if (sourceCut === undefined || candidate === undefined
      || candidate.sourceFingerprint !== sourceCut.configFingerprint
      || !isAbortSignalLike(value.signal)) return undefined;
    return Object.freeze({ sourceCut, candidate, signal: value.signal });
  } catch {
    return undefined;
  }
}

function parseSourceCut(value: unknown): HomeAutomationMigrationSimulationSourceCut | undefined {
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

function parseCandidate(value: unknown): ForeignRuleArtifactCandidate | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["status", "sourceFingerprint", "ruleRef", "title", "content"])
      || value.status !== "candidate"
      || !isDigest(value.sourceFingerprint)
      || !isBoundedId(value.ruleRef, 200)
      || !isBoundedText(value.title, 120)) return undefined;
    return Object.freeze({
      status: "candidate" as const,
      sourceFingerprint: value.sourceFingerprint,
      ruleRef: value.ruleRef,
      title: value.title,
      content: parseArtifactContent(value.content),
    });
  } catch {
    return undefined;
  }
}

function parseCatalogSet(value: unknown): readonly ParsedCatalog[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > MAX_CATALOGS) return undefined;
    const bridgeIds = new Set<string>();
    const catalogs = value.map((item) => parseCatalog(item));
    if (catalogs.some((item) => item === undefined)) return undefined;
    for (const catalog of catalogs as ParsedCatalog[]) {
      if (bridgeIds.has(catalog.bridgeId)) return undefined;
      bridgeIds.add(catalog.bridgeId);
    }
    return Object.freeze(catalogs as ParsedCatalog[]);
  } catch {
    return undefined;
  }
}

function parseCatalog(value: unknown): ParsedCatalog | undefined {
  if (!isRecord(value) || typeof value.status !== "string"
    || !isBoundedId(value.bridgeId, 200) || !Array.isArray(value.rules)
    || value.rules.length > MAX_CATALOG_RULES) return undefined;
  if (value.status === "available") {
    if (!hasExactKeys(value, ["bridgeId", "status", "epochId", "lastSeq", "rules"])
      || !isBoundedId(value.epochId, 256) || !isPositiveSafeInteger(value.lastSeq)) return undefined;
  } else if (value.status === "unavailable") {
    if (!hasExactKeys(value, ["bridgeId", "status", "rules"]) || value.rules.length !== 0) return undefined;
  } else {
    return undefined;
  }

  const refs = new Set<string>();
  const rules = value.rules.map((item) => {
    const parsed = foreignRuleSummarySchema.safeParse(item);
    if (!parsed.success || refs.has(parsed.data.ruleRef)) return undefined;
    refs.add(parsed.data.ruleRef);
    if (parsed.data.enabled === undefined) return undefined;
    return Object.freeze({
      ruleRef: parsed.data.ruleRef,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      enabled: parsed.data.enabled,
      ...(parsed.data.updatedAt === undefined ? {} : { updatedAt: parsed.data.updatedAt }),
    });
  });
  if (rules.some((item) => item === undefined)) return undefined;

  return Object.freeze({
    bridgeId: value.bridgeId,
    status: value.status,
    ...(value.status === "available" ? { epochId: value.epochId, lastSeq: value.lastSeq } : {}),
    rules: Object.freeze(rules as ParsedRuleSummary[]),
  });
}

function selectSourceCatalog(
  catalogs: readonly ParsedCatalog[],
  sourceCut: HomeAutomationMigrationSimulationSourceCut,
): ParsedCatalog | undefined {
  const matches = catalogs.filter((catalog) => catalog.bridgeId === sourceCut.bridgeId);
  if (matches.length !== 1) return undefined;
  const [catalog] = matches;
  if (catalog === undefined || catalog.status !== "available"
    || catalog.epochId !== sourceCut.epochId || catalog.lastSeq !== sourceCut.lastSeq) return undefined;
  return catalog;
}

function sameCatalogCut(left: ParsedCatalog, right: ParsedCatalog): boolean {
  return left.status === right.status
    && left.bridgeId === right.bridgeId
    && left.epochId === right.epochId
    && left.lastSeq === right.lastSeq
    && JSON.stringify(left.rules) === JSON.stringify(right.rules);
}

function mapExistingRule(
  summary: ParsedRuleSummary,
  candidate: ForeignRuleArtifactCandidate,
): HomeAutomationMigrationExistingRuleSummary | undefined {
  if (summary.enabled === undefined) return undefined;
  const trigger = mapTrigger(candidate.content.trigger);
  const actions = candidate.content.actions.map(mapAction);
  if (trigger === undefined || actions.some((action) => action === undefined)) return undefined;
  return Object.freeze({
    ruleRef: summary.ruleRef,
    enabled: summary.enabled,
    trigger,
    actions: Object.freeze(actions as HomeAutomationMigrationExistingRuleAction[]),
  });
}

function mapTrigger(
  trigger: ArtifactContent["trigger"],
): HomeAutomationMigrationExistingRuleTrigger | undefined {
  if (trigger.kind === "capability_changed") {
    return Object.freeze({ kind: "capability_changed" as const, sourceCapabilityId: trigger.source.hwCapabilityId });
  }
  return Object.freeze({
    kind: "schedule" as const,
    timezone: trigger.timezone,
    daysOfWeek: Object.freeze([...trigger.daysOfWeek]),
    at: trigger.at,
  });
}

function mapAction(
  action: ArtifactContent["actions"][number],
): HomeAutomationMigrationExistingRuleAction | undefined {
  if (action.kind === "notify_local") {
    return Object.freeze({ kind: "notify_local" as const, message: action.message });
  }
  if (action.kind === "set_boolean") {
    return Object.freeze({
      kind: "set_boolean" as const,
      targetCapabilityId: action.target.hwCapabilityId,
      value: action.value,
    });
  }
  return Object.freeze({
    kind: "set_level" as const,
    targetCapabilityId: action.target.hwCapabilityId,
    value: action.value,
  });
}

function capabilityIdsForCandidate(content: ArtifactContent): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  };
  if (content.trigger.kind === "capability_changed") add(content.trigger.source.hwCapabilityId);
  for (const condition of content.conditions) add(condition.source.hwCapabilityId);
  return Object.freeze(ids);
}

function parseEvidenceResult(
  value: unknown,
  sourceCut: HomeAutomationMigrationSimulationSourceCut,
  capabilityIds: readonly string[],
): ParsedEvidence | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["requestedSince", "requestedUntil", "events", "coverage", "truncated"])
      || !isIsoTimestamp(value.requestedSince) || !isIsoTimestamp(value.requestedUntil)
      || !Array.isArray(value.events) || value.events.length > EVIDENCE_LIMIT
      || !Array.isArray(value.coverage) || value.coverage.length === 0
      || value.truncated !== false) return undefined;

    const coverage = value.coverage.map((item) => parseCoverage(item));
    if (coverage.some((item) => item === undefined)) return undefined;
    const parsedCoverage = coverage as ParsedCoverage[];
    const coverageKeys = new Set<string>();
    for (const item of parsedCoverage) {
      const key = `${item.bridgeId}\u0000${item.epochId ?? ""}`;
      if (coverageKeys.has(key)) return undefined;
      coverageKeys.add(key);
    }
    if (parsedCoverage.some((item) => item.status !== "complete" || item.reasons.length > 0)) return undefined;
    if (!parsedCoverage.some((item) => item.bridgeId === sourceCut.bridgeId
      && item.epochId === sourceCut.epochId && item.baselineSeq === sourceCut.lastSeq)) return undefined;

    const ids = new Set(capabilityIds);
    const events = value.events.map((item) => parseEvidenceEvent(item, sourceCut, ids));
    if (events.some((item) => item === undefined)) return undefined;
    const seenProvenance = new Set<string>();
    for (const event of events as ParsedEvidenceEvent[]) {
      const key = `${event.provenance.epochId}\u0000${event.provenance.seq}\u0000${event.capabilityId}`;
      if (seenProvenance.has(key)) return undefined;
      seenProvenance.add(key);
    }
    return Object.freeze({ events: Object.freeze(events as ParsedEvidenceEvent[]) });
  } catch {
    return undefined;
  }
}

interface ParsedCoverage {
  readonly bridgeId: string;
  readonly epochId?: string;
  readonly baselineSeq?: number;
  readonly status: "complete" | "partial" | "unavailable";
  readonly reasons: readonly string[];
}

function parseCoverage(value: unknown): ParsedCoverage | undefined {
  if (!isRecord(value) || !hasAllowedKeys(value, ["bridgeId", "epochId", "baselineSeq", "baselineAt", "status", "reasons"])
    || !isBoundedId(value.bridgeId, 200) || !Array.isArray(value.reasons)
    || value.reasons.some((reason) => typeof reason !== "string" || reason.length > 64)) return undefined;
  if (value.epochId !== undefined && !isBoundedId(value.epochId, 256)) return undefined;
  if (value.baselineSeq !== undefined && !isPositiveSafeInteger(value.baselineSeq)) return undefined;
  if (value.baselineAt !== undefined && !isIsoTimestamp(value.baselineAt)) return undefined;
  if (value.status !== "complete" && value.status !== "partial" && value.status !== "unavailable") return undefined;
  return Object.freeze({
    bridgeId: value.bridgeId,
    ...(value.epochId === undefined ? {} : { epochId: value.epochId }),
    ...(value.baselineSeq === undefined ? {} : { baselineSeq: value.baselineSeq }),
    status: value.status,
    reasons: Object.freeze([...value.reasons]),
  });
}

function parseEvidenceEvent(
  value: unknown,
  sourceCut: HomeAutomationMigrationSimulationSourceCut,
  capabilityIds: ReadonlySet<string>,
): ParsedEvidenceEvent | undefined {
  if (!isRecord(value) || !isBoundedId(value.hwCapabilityId, 200)
    || !capabilityIds.has(value.hwCapabilityId)
    || !isScalar(value.value) || !isIsoTimestamp(value.observedAt)
    || !isRecord(value.provenance)
    || !hasExactKeys(value.provenance, ["bridgeId", "epochId", "seq"])
    || value.provenance.bridgeId !== sourceCut.bridgeId
    || value.provenance.epochId !== sourceCut.epochId
    || !isBoundedId(value.provenance.bridgeId, 200)
    || !isBoundedId(value.provenance.epochId, 256)
    || !isPositiveSafeInteger(value.provenance.seq)
    || value.provenance.seq <= sourceCut.lastSeq) return undefined;
  return Object.freeze({
    capabilityId: value.hwCapabilityId,
    value: value.value,
    observedAt: value.observedAt,
    provenance: Object.freeze({
      bridgeId: value.provenance.bridgeId,
      epochId: value.provenance.epochId,
      seq: value.provenance.seq,
    }),
  });
}

function mapCapabilityChangedEvents(
  evidence: ParsedEvidence,
  triggerCapabilityId: string,
  capabilityIds: readonly string[],
): readonly HomeAutomationMigrationSimulationEvent[] {
  const latest = new Map<string, string | number | boolean | null>();
  const sorted = [...evidence.events].sort((left, right) => left.provenance.seq - right.provenance.seq
    || left.observedAt.localeCompare(right.observedAt)
    || left.capabilityId.localeCompare(right.capabilityId)
    || stableScalar(left.value).localeCompare(stableScalar(right.value)));
  const mapped: HomeAutomationMigrationSimulationEvent[] = [];
  for (const event of sorted) {
    latest.set(event.capabilityId, event.value);
    if (event.capabilityId !== triggerCapabilityId) continue;
    const values = capabilityIds
      .filter((capabilityId) => latest.has(capabilityId))
      .map((capabilityId) => Object.freeze({ capabilityId, value: latest.get(capabilityId)! }));
    const eventId = `capability_changed:${event.provenance.bridgeId}:${event.provenance.epochId}:${event.provenance.seq}:${event.capabilityId}`;
    mapped.push(Object.freeze({
      eventId: eventId.length <= MAX_EVENT_ID_LENGTH ? eventId : boundedEventId(event),
      kind: "capability_changed" as const,
      occurredAt: event.observedAt,
      capabilityId: event.capabilityId,
      values: Object.freeze(values),
    }));
  }
  return Object.freeze(mapped);
}

function boundedEventId(event: ParsedEvidenceEvent): string {
  return `capability_changed:${createHash("sha256")
    .update(`${event.provenance.bridgeId}\u0000${event.provenance.epochId}\u0000${event.provenance.seq}\u0000${event.capabilityId}\u0000${event.observedAt}`, "utf8")
    .digest("hex")}`;
}

function stableScalar(value: string | number | boolean | null): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasAllowedKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedId(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= Math.min(max, MAX_ID_LENGTH)
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && Number.isFinite(Date.parse(value));
}

function isScalar(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_SCALAR_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  try {
    return isRecord(value)
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function";
  } catch {
    return false;
  }
}
