import { createHash, randomBytes } from "node:crypto";

import type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationRuleAssessment,
} from "./home-automation-migration.js";
import type { HomeAutomationMigrationStore } from "./home-automation-migration-store.js";

/** The product principal accepted by the Hub selection boundary. */
export type HomeAutomationMigrationSelectionRole =
  | "admin"
  | "adult_member"
  | "member"
  | "child"
  | "guest";

/**
 * A narrow, already-authenticated principal. Browser actor/session objects do
 * not satisfy this type and are not accepted by the facade.
 */
export interface HomeAutomationMigrationSelectionPrincipal {
  readonly principalId: string;
  readonly role: HomeAutomationMigrationSelectionRole;
  readonly privateDeviceBinding: "verified" | "unverified";
}

export type HomeAutomationMigrationSelectionStatus =
  | "selectable"
  | "prepared"
  | "unavailable";

/** The only shape returned to the review surface. */
export interface HomeAutomationMigrationSelectionProjection {
  readonly name: string;
  readonly status: HomeAutomationMigrationSelectionStatus;
  readonly token?: string;
  readonly proposalId?: string;
}

export type HomeAutomationMigrationSelectionRecordStatus =
  | "issued"
  | "processing"
  | "prepared"
  | "unavailable"
  | "expired"
  | "invalidated";

export type HomeAutomationMigrationSelectionFailureReason =
  | "prepare_unavailable"
  | "prepare_failed"
  | "source_drift"
  | "runtime_generation"
  | "expired"
  | "cache_evicted"
  | "invalidated";

/** Internal durable selection audit. It intentionally contains no raw token or name. */
export interface HomeAutomationMigrationSelectionRecord {
  readonly selectionId: string;
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly principal: HomeAutomationMigrationSelectionPrincipal;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly sourceFingerprint: string;
  readonly tokenDigest: string;
  readonly generation: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: HomeAutomationMigrationSelectionRecordStatus;
  readonly revision: number;
  readonly proposalId?: string;
  readonly proposalRevision?: number;
  readonly failureReason?: HomeAutomationMigrationSelectionFailureReason;
  readonly completedAt?: string;
}

export interface HomeAutomationMigrationSelectionIssue {
  readonly selectionId: string;
  readonly migrationId: string;
  readonly ruleRef: string;
  readonly principal: HomeAutomationMigrationSelectionPrincipal;
  readonly sourceBridgeId: string;
  readonly sourceEpochId: string;
  readonly sourceLastSeq: number;
  readonly sourceFingerprint: string;
  /** sha256:<64 lowercase hex>; the raw token never crosses this port. */
  readonly tokenDigest: string;
  readonly generation: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface HomeAutomationMigrationSelectionIssueResult {
  readonly outcome: "created" | "existing";
  readonly selection: HomeAutomationMigrationSelectionRecord;
}

export interface HomeAutomationMigrationSelectionClaimInput {
  readonly selectionId: string;
  readonly tokenDigest: string;
  readonly principal: HomeAutomationMigrationSelectionPrincipal;
  readonly generation: string;
  readonly now: string;
}

export type HomeAutomationMigrationSelectionClaim =
  | { readonly outcome: "claimed"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "replay"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "forbidden"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "expired"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "invalidated"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "unavailable"; readonly selection: HomeAutomationMigrationSelectionRecord }
  | { readonly outcome: "missing"; readonly selection?: undefined };

export interface HomeAutomationMigrationSelectionCompletion {
  readonly selectionId: string;
  readonly expectedRevision: number;
  readonly principal: HomeAutomationMigrationSelectionPrincipal;
  readonly generation: string;
  readonly completedAt: string;
  readonly status: "prepared" | "unavailable";
  readonly proposalId?: string;
  readonly proposalRevision?: number;
  readonly failureReason?: HomeAutomationMigrationSelectionFailureReason;
}

export interface HomeAutomationMigrationSelectionInvalidation {
  readonly selectionId: string;
  readonly generation: string;
  readonly now: string;
  readonly reason: Extract<HomeAutomationMigrationSelectionFailureReason, "cache_evicted" | "runtime_generation" | "invalidated">;
}

/**
 * The prepare port is deliberately narrower than the runtime. It may create
 * or replay a governed Proposal, but it cannot receive a browser actor or a
 * selection token.
 */
export type HomeAutomationMigrationSelectionPrepareResult =
  | {
    readonly status: "prepared";
    readonly proposalId: string;
    readonly proposalRevision?: number;
  }
  | {
    readonly status: "unavailable";
    readonly reason?: Extract<HomeAutomationMigrationSelectionFailureReason, "prepare_unavailable" | "prepare_failed">;
  };

export interface HomeAutomationMigrationSelectionStorePort {
  get(migrationId: string): HomeAutomationMigrationAssessment | undefined;
  list(): readonly HomeAutomationMigrationAssessment[];
  issueSelection(input: HomeAutomationMigrationSelectionIssue): HomeAutomationMigrationSelectionIssueResult;
  getSelection(selectionId: string): HomeAutomationMigrationSelectionRecord | undefined;
  listSelections(input?: {
    readonly migrationId?: string;
    readonly principalId?: string;
    readonly generation?: string;
    readonly status?: HomeAutomationMigrationSelectionRecordStatus;
  }): readonly HomeAutomationMigrationSelectionRecord[];
  claimSelection(input: HomeAutomationMigrationSelectionClaimInput): HomeAutomationMigrationSelectionClaim;
  completeSelection(input: HomeAutomationMigrationSelectionCompletion): boolean;
  invalidateSelection(input: HomeAutomationMigrationSelectionInvalidation): boolean;
}

export interface HomeAutomationMigrationSelectionFacadeOptions {
  readonly store: HomeAutomationMigrationSelectionStorePort | HomeAutomationMigrationStore;
  readonly prepareRule: (input: {
    readonly migrationId: string;
    readonly ruleRef: string;
  }) => Promise<HomeAutomationMigrationSelectionPrepareResult> | HomeAutomationMigrationSelectionPrepareResult;
  /** Restart-only lookup; it may link an exact existing Proposal, never create one. */
  readonly lookupPreparedRule?: (input: {
    readonly migrationId: string;
    readonly ruleRef: string;
    readonly sourceBridgeId: string;
    readonly sourceEpochId: string;
    readonly sourceLastSeq: number;
    readonly sourceFingerprint: string;
  }) => Promise<HomeAutomationMigrationSelectionPrepareResult> | HomeAutomationMigrationSelectionPrepareResult;
  readonly clock?: () => string;
  /** One generation per process. The runtime should omit this and generate one. */
  readonly generation?: string;
  /** Test seam for deterministic 128-bit opaque tokens. */
  readonly tokenFactory?: () => string;
  /** Test seam for deterministic selection ids. */
  readonly selectionIdFactory?: () => string;
  readonly ttlMs?: number;
  readonly maxTokenCacheEntries?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TOKEN_CACHE_ENTRIES = 256;
const MAX_RECOVERY_SELECTIONS = 256;
const MAX_PRINCIPAL_ID_LENGTH = 200;
const MAX_GENERATION_LENGTH = 128;
const MAX_SELECTION_ID_LENGTH = 128;
const MAX_FAILURE_REASON_LENGTH = 64;
const TOKEN_HEX = /^[a-f0-9]{32}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GENERATION = /^[a-zA-Z0-9._:-]{1,128}$/u;
const SELECTION_ID = /^[a-f0-9]{32,128}$/u;
const ROLES: readonly HomeAutomationMigrationSelectionRole[] = [
  "admin", "adult_member", "member", "child", "guest",
];

/**
 * Hub-owned facade for issuing and consuming short-lived rule selections.
 * Raw tokens are held only in a bounded map in this instance. The migration
 * store persists the digest and actor audit, never the raw token.
 */
export class HomeAutomationMigrationSelectionFacade {
  private readonly store: HomeAutomationMigrationSelectionStorePort;
  private readonly prepareRule: HomeAutomationMigrationSelectionFacadeOptions["prepareRule"];
  private readonly lookupPreparedRule?: HomeAutomationMigrationSelectionFacadeOptions["lookupPreparedRule"];
  private readonly clock: () => string;
  private readonly generation: string;
  private readonly tokenFactory: () => string;
  private readonly selectionIdFactory: () => string;
  private readonly ttlMs: number;
  private readonly maxTokenCacheEntries: number;
  private readonly tokenCache = new Map<string, { readonly selectionId: string; readonly digest: string }>();
  private closed = false;

  constructor(options: HomeAutomationMigrationSelectionFacadeOptions) {
    if (!options || !options.store || typeof options.prepareRule !== "function") {
      throw new TypeError("Home automation migration selection options are required");
    }
    this.store = options.store;
    this.prepareRule = options.prepareRule;
    this.lookupPreparedRule = options.lookupPreparedRule;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.generation = options.generation ?? create128BitHex();
    this.tokenFactory = options.tokenFactory ?? create128BitHex;
    this.selectionIdFactory = options.selectionIdFactory ?? create128BitHex;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTokenCacheEntries = options.maxTokenCacheEntries ?? DEFAULT_MAX_TOKEN_CACHE_ENTRIES;
    validateGeneration(this.generation);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 24 * 60 * 60 * 1000) {
      throw new TypeError("Home automation migration selection ttl is invalid");
    }
    if (!Number.isSafeInteger(this.maxTokenCacheEntries) || this.maxTokenCacheEntries < 1 || this.maxTokenCacheEntries > DEFAULT_MAX_TOKEN_CACHE_ENTRIES) {
      throw new TypeError("Home automation migration selection cache bound is invalid");
    }
  }

  /** Enumerates every assessment and returns only safe review projections. */
  list(principal: HomeAutomationMigrationSelectionPrincipal): readonly HomeAutomationMigrationSelectionProjection[] {
    this.assertOpen();
    validatePrincipal(principal);
    const projections: HomeAutomationMigrationSelectionProjection[] = [];
    let assessments: readonly HomeAutomationMigrationAssessment[];
    try {
      assessments = this.store.list();
    } catch {
      return [];
    }
    for (const assessment of assessments) {
      for (const rule of assessment.rules) {
        projections.push(this.projectRule(assessment, rule, principal));
      }
    }
    return projections;
  }

  /** Explicit alias for callers that prefer the operation name. */
  listSelections(principal: HomeAutomationMigrationSelectionPrincipal): readonly HomeAutomationMigrationSelectionProjection[] {
    return this.list(principal);
  }

  /**
   * Consumes a token once. A replay by the same principal reads the durable
   * result; no second Proposal call is made.
   */
  async submitSelection(
    token: string,
    principal: HomeAutomationMigrationSelectionPrincipal,
  ): Promise<HomeAutomationMigrationSelectionProjection> {
    this.assertOpen();
    validatePrincipal(principal);
    if (principal.privateDeviceBinding !== "verified") return unavailableProjection();
    if (!isToken(token)) return unavailableProjection();
    const cached = this.tokenCache.get(token);
    if (cached === undefined) return unavailableProjection();
    const computedDigest = digestToken(token);
    if (!safeDigestEqual(cached.digest, computedDigest)) return unavailableProjection();
    const record = this.store.getSelection(cached.selectionId);
    if (record === undefined || !safeDigestEqual(record.tokenDigest, computedDigest) || record.generation !== this.generation) {
      return unavailableProjection();
    }
    const now = this.now();
    if (Date.parse(now) >= Date.parse(record.expiresAt) && record.status !== "issued") {
      return unavailableProjection();
    }
    const claim = this.store.claimSelection({
      selectionId: record.selectionId,
      tokenDigest: cached.digest,
      principal,
      generation: this.generation,
      now,
    });
    if (claim.outcome !== "claimed") return this.projectClaim(claim, record);

    let prepared: HomeAutomationMigrationSelectionPrepareResult;
    try {
      prepared = await this.prepareRule({ migrationId: claim.selection.migrationId, ruleRef: claim.selection.ruleRef });
    } catch {
      prepared = { status: "unavailable", reason: "prepare_unavailable" };
    }
    if (prepared.status === "prepared" && isBoundedProposalId(prepared.proposalId)) {
      const completed = this.store.completeSelection({
        selectionId: claim.selection.selectionId,
        expectedRevision: claim.selection.revision,
        principal,
        generation: this.generation,
        completedAt: this.now(),
        status: "prepared",
        proposalId: prepared.proposalId,
        ...(prepared.proposalRevision === undefined ? {} : { proposalRevision: prepared.proposalRevision }),
      });
      if (completed) {
        return this.projectionForRecord({ ...claim.selection, status: "prepared", proposalId: prepared.proposalId });
      }
      const converged = this.store.getSelection(claim.selection.selectionId);
      return converged === undefined ? unavailableProjection() : this.projectionForRecord(converged);
    }

    const completed = this.store.completeSelection({
      selectionId: claim.selection.selectionId,
      expectedRevision: claim.selection.revision,
      principal,
      generation: this.generation,
      completedAt: this.now(),
      status: "unavailable",
      failureReason: prepared.status === "unavailable" && prepared.reason !== undefined
        ? prepared.reason
        : "prepare_failed",
    });
    if (completed) {
      return this.projectionForRecord({
        ...claim.selection,
        status: "unavailable",
        failureReason: prepared.status === "unavailable" && prepared.reason !== undefined
          ? prepared.reason
          : "prepare_failed",
      });
    }
    const converged = this.store.getSelection(claim.selection.selectionId);
    return converged === undefined ? unavailableProjection() : this.projectionForRecord(converged);
  }

  /** Short alias for HTTP adapters. */
  submit(token: string, principal: HomeAutomationMigrationSelectionPrincipal): Promise<HomeAutomationMigrationSelectionProjection> {
    return this.submitSelection(token, principal);
  }

  /**
   * Completes durable processing rows after a restart. The persisted actor and
   * source identity are used; no synthetic system actor or fresh selection is
   * created. The recovery port performs only an exact existing-Proposal lookup.
   */
  async recover(): Promise<readonly HomeAutomationMigrationSelectionProjection[]> {
    this.assertOpen();
    const rows = [
      ...this.store.listSelections({ status: "processing" }),
      ...this.store.listSelections({ status: "issued" }),
    ].slice(0, MAX_RECOVERY_SELECTIONS);
    const projections: HomeAutomationMigrationSelectionProjection[] = [];
    for (const row of rows) {
      if (row.status === "issued" && row.generation !== this.generation) {
        this.store.invalidateSelection({
          selectionId: row.selectionId,
          generation: row.generation,
          now: this.now(),
          reason: "runtime_generation",
        });
        const invalidated = this.store.getSelection(row.selectionId);
        if (invalidated !== undefined) projections.push(this.projectionForRecord(invalidated));
        continue;
      }
      if (row.status !== "processing") continue;
      let prepared: HomeAutomationMigrationSelectionPrepareResult = { status: "unavailable", reason: "prepare_unavailable" };
      if (this.lookupPreparedRule !== undefined) {
        try {
          prepared = await this.lookupPreparedRule({
            migrationId: row.migrationId,
            ruleRef: row.ruleRef,
            sourceBridgeId: row.sourceBridgeId,
            sourceEpochId: row.sourceEpochId,
            sourceLastSeq: row.sourceLastSeq,
            sourceFingerprint: row.sourceFingerprint,
          });
        } catch {
          prepared = { status: "unavailable", reason: "prepare_unavailable" };
        }
      }
      const completed = prepared.status === "prepared" && isBoundedProposalId(prepared.proposalId)
        ? this.store.completeSelection({
          selectionId: row.selectionId,
          expectedRevision: row.revision,
          principal: row.principal,
          generation: row.generation,
          completedAt: this.now(),
          status: "prepared",
          proposalId: prepared.proposalId,
          ...(prepared.proposalRevision === undefined ? {} : { proposalRevision: prepared.proposalRevision }),
        })
        : this.store.completeSelection({
          selectionId: row.selectionId,
          expectedRevision: row.revision,
          principal: row.principal,
          generation: row.generation,
          completedAt: this.now(),
          status: "unavailable",
          failureReason: prepared.status === "unavailable" && prepared.reason !== undefined ? prepared.reason : "prepare_failed",
        });
      const current = this.store.getSelection(row.selectionId);
      if (completed && current !== undefined) projections.push(this.projectionForRecord(current));
    }
    return projections;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tokenCache.clear();
  }

  private projectRule(
    assessment: HomeAutomationMigrationAssessment,
    rule: HomeAutomationMigrationRuleAssessment,
    principal: HomeAutomationMigrationSelectionPrincipal,
  ): HomeAutomationMigrationSelectionProjection {
    const name = safeRuleName(rule.name);
    if (assessment.status !== "assessed" || rule.disposition !== "eligible" || rule.workflow === undefined) {
      return { name, status: "unavailable" };
    }
    if (rule.workflow.status !== "assessed") {
      return rule.workflow.status === "translated" || rule.workflow.status === "simulated" || rule.workflow.status === "ready"
        ? rule.workflow.proposalId === undefined
          ? { name, status: "unavailable" }
          : { name, status: "prepared", proposalId: rule.workflow.proposalId }
        : { name, status: "unavailable" };
    }
    if (principal.privateDeviceBinding !== "verified") return { name, status: "selectable" };
    const sourceFingerprint = rule.sourceFingerprint;
    if (sourceFingerprint === undefined) return { name, status: "unavailable" };
    let existing: readonly HomeAutomationMigrationSelectionRecord[];
    try {
      existing = this.store.listSelections({ migrationId: assessment.migrationId, principalId: principal.principalId, generation: this.generation });
    } catch {
      return { name, status: "unavailable" };
    }
    const matching = existing.find((item) => selectionMatches(item, assessment, rule, principal, sourceFingerprint));
    if (matching !== undefined) {
      if (matching.status === "prepared") return this.projectionForRecord(matching, name);
      if (matching.status === "unavailable" || matching.status === "processing") return { name, status: "unavailable" };
      if (matching.status === "issued") {
        const raw = findRawToken(this.tokenCache, matching);
        if (raw !== undefined) {
          const now = this.now();
          if (Date.parse(now) < Date.parse(matching.expiresAt)) return { name, status: "selectable", token: raw };
          const expired = this.store.claimSelection({
            selectionId: matching.selectionId,
            tokenDigest: matching.tokenDigest,
            principal,
            generation: matching.generation,
            now,
          });
          if (expired.outcome !== "expired") return this.projectClaim(expired, matching);
        }
        this.store.invalidateSelection({
          selectionId: matching.selectionId,
          generation: matching.generation,
          now: this.now(),
          reason: "cache_evicted",
        });
      }
    }
    const token = this.newToken();
    const issuedAt = this.now();
    const expiresAt = new Date(Date.parse(issuedAt) + this.ttlMs).toISOString();
    const selectionId = this.newSelectionId();
    const issue = this.store.issueSelection({
      selectionId,
      migrationId: assessment.migrationId,
      ruleRef: rule.ruleRef,
      principal,
      sourceBridgeId: assessment.sourceBridgeId,
      sourceEpochId: assessment.sourceEpochId,
      sourceLastSeq: assessment.sourceLastSeq,
      sourceFingerprint,
      tokenDigest: digestToken(token),
      generation: this.generation,
      issuedAt,
      expiresAt,
    });
    const selected = issue.selection;
    if (selected.status === "issued") {
      if (!this.rememberToken(token, selected)) return { name, status: "unavailable" };
      return { name, status: "selectable", token };
    }
    return this.projectionForRecord(selected, name);
  }

  private projectionForRecord(
    record: HomeAutomationMigrationSelectionRecord,
    preferredName?: string,
  ): HomeAutomationMigrationSelectionProjection {
    const assessment = this.store.get(record.migrationId);
    const rule = assessment?.rules.find((item) => item.ruleRef === record.ruleRef);
    const name = preferredName ?? safeRuleName(rule?.name);
    if (record.status === "prepared" && record.proposalId !== undefined) {
      return { name, status: "prepared", proposalId: record.proposalId };
    }
    if (record.status === "issued") {
      const token = findRawToken(this.tokenCache, record);
      return token === undefined ? { name, status: "unavailable" } : { name, status: "selectable", token };
    }
    return { name, status: "unavailable" };
  }

  private projectClaim(
    claim: HomeAutomationMigrationSelectionClaim,
    fallback: HomeAutomationMigrationSelectionRecord,
  ): HomeAutomationMigrationSelectionProjection {
    if (claim.selection === undefined || claim.outcome !== "replay") return unavailableProjection();
    if (Date.parse(this.now()) >= Date.parse(claim.selection.expiresAt)) return unavailableProjection();
    return claim.selection.status === "prepared"
      ? this.projectionForRecord(claim.selection, safeRuleName(this.store.get(fallback.migrationId)?.rules.find((rule) => rule.ruleRef === fallback.ruleRef)?.name))
      : unavailableProjection();
  }

  private newToken(): string {
    const token = this.tokenFactory();
    if (!isToken(token)) throw new TypeError("Home automation migration selection token factory returned invalid token");
    if (this.tokenCache.has(token)) throw new Error("Home automation migration selection token collision");
    return token;
  }

  private newSelectionId(): string {
    const selectionId = this.selectionIdFactory();
    if (!SELECTION_ID.test(selectionId)) throw new TypeError("Home automation migration selection id factory returned invalid id");
    return selectionId;
  }

  private rememberToken(token: string, record: HomeAutomationMigrationSelectionRecord): boolean {
    if (!safeDigestEqual(digestToken(token), record.tokenDigest)) return false;
    while (this.tokenCache.size >= this.maxTokenCacheEntries) {
      const oldest = this.tokenCache.entries().next().value as [string, { readonly selectionId: string; readonly digest: string }] | undefined;
      if (oldest === undefined) break;
      this.tokenCache.delete(oldest[0]);
      this.store.invalidateSelection({
        selectionId: oldest[1].selectionId,
        generation: record.generation,
        now: this.now(),
        reason: "cache_evicted",
      });
    }
    this.tokenCache.set(token, { selectionId: record.selectionId, digest: record.tokenDigest });
    return true;
  }

  private now(): string {
    const value = this.clock();
    if (!isIsoTimestamp(value)) throw new TypeError("Home automation migration selection clock returned invalid timestamp");
    return value;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Home automation migration selection facade is closed");
  }
}

export function digestToken(token: string): string {
  if (!isToken(token)) throw new TypeError("Home automation migration selection token is invalid");
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function validateSelectionPrincipal(value: unknown): asserts value is HomeAutomationMigrationSelectionPrincipal {
  validatePrincipal(value);
}

export function validateSelectionRecord(value: unknown): HomeAutomationMigrationSelectionRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["selectionId", "migrationId", "ruleRef", "principal", "sourceBridgeId", "sourceEpochId", "sourceLastSeq", "sourceFingerprint", "tokenDigest", "generation", "issuedAt", "expiresAt", "status", "revision", "proposalId", "proposalRevision", "failureReason", "completedAt"])
    || !isSelectionId(value.selectionId)
    || !isMigrationId(value.migrationId)
    || !isBoundedText(value.ruleRef, 200)
    || !isBoundedText(value.sourceBridgeId, 200)
    || !isBoundedText(value.sourceEpochId, 256)
    || !isPositiveSafeInteger(value.sourceLastSeq)
    || !isDigest(value.sourceFingerprint)
    || !isDigest(value.tokenDigest)
    || !isGeneration(value.generation)
    || !isIsoTimestamp(value.issuedAt)
    || !isIsoTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
    || !isSelectionStatus(value.status)
    || !isPositiveSafeInteger(value.revision)) {
    throw new Error("Stored home automation migration selection is corrupt");
  }
  validatePrincipal(value.principal);
  if (value.principal.privateDeviceBinding !== "verified") throw new Error("Stored home automation migration selection is corrupt");
  if (value.proposalId !== undefined && !isBoundedProposalId(value.proposalId)) throw new Error("Stored home automation migration selection is corrupt");
  if (value.proposalRevision !== undefined && !isPositiveSafeInteger(value.proposalRevision)) throw new Error("Stored home automation migration selection is corrupt");
  if (value.failureReason !== undefined && !isFailureReason(value.failureReason)) throw new Error("Stored home automation migration selection is corrupt");
  if (value.completedAt !== undefined && (!isIsoTimestamp(value.completedAt) || Date.parse(value.completedAt) < Date.parse(value.issuedAt))) throw new Error("Stored home automation migration selection is corrupt");
  if (value.status === "issued" || value.status === "processing") {
    if (value.proposalId !== undefined || value.proposalRevision !== undefined || value.failureReason !== undefined || value.completedAt !== undefined) throw new Error("Stored home automation migration selection is corrupt");
  }
  if (value.status === "prepared") {
    if (value.proposalId === undefined || value.failureReason !== undefined || value.completedAt === undefined) throw new Error("Stored home automation migration selection is corrupt");
  }
  if (value.status === "unavailable" || value.status === "expired" || value.status === "invalidated") {
    if (value.proposalId !== undefined || value.proposalRevision !== undefined || value.failureReason === undefined || value.completedAt === undefined) throw new Error("Stored home automation migration selection is corrupt");
  }
  return {
    selectionId: value.selectionId,
    migrationId: value.migrationId,
    ruleRef: value.ruleRef,
    principal: { ...value.principal },
    sourceBridgeId: value.sourceBridgeId,
    sourceEpochId: value.sourceEpochId,
    sourceLastSeq: value.sourceLastSeq,
    sourceFingerprint: value.sourceFingerprint,
    tokenDigest: value.tokenDigest,
    generation: value.generation,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    status: value.status,
    revision: value.revision,
    ...(value.proposalId === undefined ? {} : { proposalId: value.proposalId }),
    ...(value.proposalRevision === undefined ? {} : { proposalRevision: value.proposalRevision }),
    ...(value.failureReason === undefined ? {} : { failureReason: value.failureReason }),
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
  };
}

export function validateSelectionIssue(value: unknown): asserts value is HomeAutomationMigrationSelectionIssue {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["selectionId", "migrationId", "ruleRef", "principal", "sourceBridgeId", "sourceEpochId", "sourceLastSeq", "sourceFingerprint", "tokenDigest", "generation", "issuedAt", "expiresAt"])
    || !isSelectionId(value.selectionId)
    || !isMigrationId(value.migrationId)
    || !isBoundedText(value.ruleRef, 200)
    || !isBoundedText(value.sourceBridgeId, 200)
    || !isBoundedText(value.sourceEpochId, 256)
    || !isPositiveSafeInteger(value.sourceLastSeq)
    || !isDigest(value.sourceFingerprint)
    || !isDigest(value.tokenDigest)
    || !isGeneration(value.generation)
    || !isIsoTimestamp(value.issuedAt)
    || !isIsoTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    throw new TypeError("Home automation migration selection issue is invalid");
  }
  validatePrincipal(value.principal);
  if (value.principal.privateDeviceBinding !== "verified") throw new TypeError("Home automation migration selection issue is invalid");
}

export function validateSelectionClaim(value: unknown): asserts value is HomeAutomationMigrationSelectionClaimInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ["selectionId", "tokenDigest", "principal", "generation", "now"]) || !isSelectionId(value.selectionId) || !isDigest(value.tokenDigest) || !isGeneration(value.generation) || !isIsoTimestamp(value.now)) {
    throw new TypeError("Home automation migration selection claim is invalid");
  }
  validatePrincipal(value.principal);
  if (value.principal.privateDeviceBinding !== "verified") throw new TypeError("Home automation migration selection claim is invalid");
}

export function validateSelectionCompletion(value: unknown): asserts value is HomeAutomationMigrationSelectionCompletion {
  if (!isRecord(value) || !hasOnlyKeys(value, ["selectionId", "expectedRevision", "principal", "generation", "completedAt", "status", "proposalId", "proposalRevision", "failureReason"]) || !isSelectionId(value.selectionId) || !isPositiveSafeInteger(value.expectedRevision)
    || !isGeneration(value.generation) || !isIsoTimestamp(value.completedAt)
    || (value.status !== "prepared" && value.status !== "unavailable")) {
    throw new TypeError("Home automation migration selection completion is invalid");
  }
  validatePrincipal(value.principal);
  if (value.principal.privateDeviceBinding !== "verified") throw new TypeError("Home automation migration selection completion is invalid");
  if (value.proposalId !== undefined && !isBoundedProposalId(value.proposalId)) throw new TypeError("Home automation migration selection completion is invalid");
  if (value.proposalRevision !== undefined && !isPositiveSafeInteger(value.proposalRevision)) throw new TypeError("Home automation migration selection completion is invalid");
  if (value.failureReason !== undefined && !isFailureReason(value.failureReason)) throw new TypeError("Home automation migration selection completion is invalid");
  if (value.status === "prepared" && (value.proposalId === undefined || value.failureReason !== undefined)) throw new TypeError("Home automation migration selection completion is invalid");
  if (value.status === "unavailable" && (value.proposalId !== undefined || value.proposalRevision !== undefined || value.failureReason === undefined)) throw new TypeError("Home automation migration selection completion is invalid");
}

export function validateSelectionInvalidation(value: unknown): asserts value is HomeAutomationMigrationSelectionInvalidation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["selectionId", "generation", "now", "reason"]) || !isSelectionId(value.selectionId) || !isGeneration(value.generation) || !isIsoTimestamp(value.now)
    || (value.reason !== "cache_evicted" && value.reason !== "runtime_generation" && value.reason !== "invalidated")) {
    throw new TypeError("Home automation migration selection invalidation is invalid");
  }
}

export function cloneSelection(value: HomeAutomationMigrationSelectionRecord): HomeAutomationMigrationSelectionRecord {
  return { ...value, principal: { ...value.principal } };
}

function selectionMatches(
  record: HomeAutomationMigrationSelectionRecord,
  assessment: HomeAutomationMigrationAssessment,
  rule: HomeAutomationMigrationRuleAssessment,
  principal: HomeAutomationMigrationSelectionPrincipal,
  sourceFingerprint: string,
): boolean {
  return record.migrationId === assessment.migrationId
    && record.ruleRef === rule.ruleRef
    && samePrincipal(record.principal, principal)
    && record.sourceBridgeId === assessment.sourceBridgeId
    && record.sourceEpochId === assessment.sourceEpochId
    && record.sourceLastSeq === assessment.sourceLastSeq
    && record.sourceFingerprint === sourceFingerprint;
}

function findRawToken(cache: Map<string, { readonly selectionId: string; readonly digest: string }>, record: HomeAutomationMigrationSelectionRecord): string | undefined {
  for (const [token, value] of cache) {
    if (value.selectionId === record.selectionId && value.digest === record.tokenDigest) return token;
  }
  return undefined;
}

function unavailableProjection(): HomeAutomationMigrationSelectionProjection {
  return { name: "Unavailable", status: "unavailable" };
}

function safeRuleName(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "Unnamed automation";
}

function samePrincipal(left: HomeAutomationMigrationSelectionPrincipal, right: HomeAutomationMigrationSelectionPrincipal): boolean {
  return left.principalId === right.principalId && left.role === right.role && left.privateDeviceBinding === right.privateDeviceBinding;
}

function validatePrincipal(value: unknown): asserts value is HomeAutomationMigrationSelectionPrincipal {
  if (!isRecord(value) || !hasOnlyKeys(value, ["principalId", "role", "privateDeviceBinding"]) || !isBoundedText(value.principalId, MAX_PRINCIPAL_ID_LENGTH)
    || !ROLES.includes(value.role as HomeAutomationMigrationSelectionRole)
    || (value.privateDeviceBinding !== "verified" && value.privateDeviceBinding !== "unverified")) {
    throw new TypeError("Home automation migration selection principal is invalid");
  }
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  let different = 0;
  for (let index = 0; index < leftBytes.length; index += 1) different |= leftBytes[index]! ^ rightBytes[index]!;
  return different === 0;
}

function validateGeneration(value: unknown): asserts value is string {
  if (!isGeneration(value)) throw new TypeError("Home automation migration selection generation is invalid");
}

function isGeneration(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_GENERATION_LENGTH && GENERATION.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HEX.test(value);
}

function isSelectionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SELECTION_ID_LENGTH && SELECTION_ID.test(value);
}

function isMigrationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000\r\n]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isSelectionStatus(value: unknown): value is HomeAutomationMigrationSelectionRecordStatus {
  return value === "issued" || value === "processing" || value === "prepared" || value === "unavailable" || value === "expired" || value === "invalidated";
}

function isFailureReason(value: unknown): value is HomeAutomationMigrationSelectionFailureReason {
  return typeof value === "string" && value.length <= MAX_FAILURE_REASON_LENGTH
    && (value === "prepare_unavailable" || value === "prepare_failed" || value === "source_drift"
      || value === "runtime_generation" || value === "expired" || value === "cache_evicted" || value === "invalidated");
}

function isBoundedProposalId(value: unknown): value is string {
  return isBoundedText(value, 200);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function create128BitHex(): string {
  return randomBytes(16).toString("hex");
}
