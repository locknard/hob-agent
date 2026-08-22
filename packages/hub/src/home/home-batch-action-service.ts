import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Context, Service } from "@deepseek-ai/cordis";

import type { ActionAuthorityPolicyClass } from "../authority/authority-coordinator.js";
import type {
  HouseholdActionDescriptor,
  RequestHouseholdActionInput,
} from "./household-review-center-service.js";
import type {
  OneShotAction,
  OneShotActionActor,
  OneShotActionResult,
} from "../authority/one-shot-action-plane.js";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

const MAX_REQUEST_ID_LENGTH = 200;
const MAX_CAPABILITY_ID_LENGTH = 200;
const MAX_BATCH_TARGETS = 32;
const MAX_LABEL_LENGTH = 512;
const MAX_ACTION_LABEL_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 1_024;
const MAX_VALUE_LENGTH = 256;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MEDIA_REF_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeBatchActions: HomeBatchActionService;
  }
}

/** The batch command carries the exact neutral descriptor selected for each target. */
export type HomeBatchActionDescriptor = Omit<HouseholdActionDescriptor, "policyClass"> & {
  readonly policyClass?: ActionAuthorityPolicyClass;
};

export interface HomeBatchActionTarget {
  readonly capabilityId: string;
  readonly descriptor: HomeBatchActionDescriptor;
}

export interface HomeBatchActionCommand {
  readonly requestId: string;
  readonly capabilityIds: readonly string[];
  readonly actor: OneShotActionActor;
  readonly targets: readonly HomeBatchActionTarget[];
}

export type HomeBatchActionStatus = "verified" | "pending_confirmation" | "failed" | "unknown";

export interface HomeBatchActionItem {
  readonly capabilityId: string;
  readonly requestId: string;
  readonly policyClass: ActionAuthorityPolicyClass;
  readonly status: HomeBatchActionStatus;
  readonly ticketId?: string;
  readonly reason: string;
  readonly verification: HomeBatchActionStatus;
}

export interface HomeBatchActionCounts {
  readonly total: number;
  readonly verified: number;
  readonly pending_confirmation: number;
  readonly failed: number;
  readonly unknown: number;
}

export interface HomeBatchActionResult {
  readonly requestId: string;
  readonly items: readonly HomeBatchActionItem[];
  readonly counts: HomeBatchActionCounts;
}

export interface HomeBatchActionRecord {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly result: HomeBatchActionResult;
}

/** The owner exposes one descriptor read and one governed action request per target. */
export interface HomeBatchActionReviewCenterPort {
  actionDescriptorFor(capabilityId: string): HouseholdActionDescriptor | undefined;
  requestAction(input: RequestHouseholdActionInput): Promise<OneShotActionResult>;
}

/** The store binds one batch request id to one immutable command result. */
export interface HomeBatchActionStore {
  find(requestId: string): HomeBatchActionRecord | undefined;
  save(record: HomeBatchActionRecord): void;
  close?(): void;
}

export type HomeBatchActionErrorCode =
  | "invalid_command"
  | "unauthorized_actor"
  | "duplicate_target"
  | "descriptor_unavailable"
  | "idempotency_conflict"
  | "persistence_failed"
  | "review_center_unavailable";

export class HomeBatchActionError extends Error {
  constructor(
    readonly code: HomeBatchActionErrorCode,
    message: string,
    readonly capabilityId?: string,
  ) {
    super(message);
    this.name = "HomeBatchActionError";
  }
}

/** A deterministic local store supports unit tests and embedders. */
export class InMemoryHomeBatchActionStore implements HomeBatchActionStore {
  private readonly records = new Map<string, HomeBatchActionRecord>();

  constructor(initial: readonly HomeBatchActionRecord[] = []) {
    for (const record of initial) this.save(record);
  }

  find(requestId: string): HomeBatchActionRecord | undefined {
    const record = this.records.get(requestId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  save(record: HomeBatchActionRecord): void {
    validateRecord(record);
    const existing = this.records.get(record.requestId);
    if (existing !== undefined && existing.fingerprint !== record.fingerprint) {
      throw new HomeBatchActionError("idempotency_conflict", "Batch request id already names another command");
    }
    this.records.set(record.requestId, cloneRecord(record));
  }
}

export interface SqliteHomeBatchActionStoreOptions {
  readonly path: string;
}

/** A private SQLite store keeps completed batch bindings across Hub restarts. */
export class SqliteHomeBatchActionStore implements HomeBatchActionStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: SqliteHomeBatchActionStoreOptions | string) {
    const path = typeof options === "string" ? options : options.path;
    if (typeof path !== "string" || path.length === 0) throw new TypeError("home batch action store path is required");
    this.path = path;
    if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_batch_action_records (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL
      ) STRICT;
    `);
    this.ensurePrivateFiles();
  }

  find(requestId: string): HomeBatchActionRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT request_id, fingerprint, result_json FROM home_batch_action_records WHERE request_id = ?").get(requestId) as
      | { request_id?: unknown; fingerprint?: unknown; result_json?: unknown }
      | undefined;
    if (row === undefined) return undefined;
    try {
      if (typeof row.request_id !== "string" || typeof row.fingerprint !== "string" || typeof row.result_json !== "string") {
        throw new Error("record fields");
      }
      const record: unknown = {
        requestId: row.request_id,
        fingerprint: row.fingerprint,
        result: JSON.parse(row.result_json),
      };
      validateRecord(record);
      return cloneRecord(record);
    } catch {
      throw new HomeBatchActionError("persistence_failed", "Stored batch idempotency record is invalid");
    }
  }

  save(record: HomeBatchActionRecord): void {
    this.assertOpen();
    validateRecord(record);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.find(record.requestId);
      if (existing !== undefined && existing.fingerprint !== record.fingerprint) {
        throw new HomeBatchActionError("idempotency_conflict", "Batch request id already names another command");
      }
      if (existing === undefined) {
        this.db.prepare(`INSERT INTO home_batch_action_records (request_id, fingerprint, result_json)
          VALUES (?, ?, ?)`).run(record.requestId, record.fingerprint, JSON.stringify(record.result));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original persistence error */ }
      throw error;
    } finally {
      this.ensurePrivateFiles();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new HomeBatchActionError("persistence_failed", "Home batch action store is closed");
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

export interface HomeBatchActionRunnerOptions {
  readonly reviewCenter: HomeBatchActionReviewCenterPort;
  readonly store?: HomeBatchActionStore;
  readonly maxTargets?: number;
}

/** Coordinates bounded target validation, per-target owner calls, and batch replay. */
export class HomeBatchActionRunner {
  private readonly reviewCenter: HomeBatchActionReviewCenterPort;
  private readonly store: HomeBatchActionStore;
  private readonly maxTargets: number;
  private readonly inFlight = new Map<string, { readonly fingerprint: string; readonly promise: Promise<HomeBatchActionResult> }>();

  constructor(options: HomeBatchActionRunnerOptions) {
    if (typeof options?.reviewCenter?.actionDescriptorFor !== "function"
      || typeof options.reviewCenter.requestAction !== "function") {
      throw new HomeBatchActionError("review_center_unavailable", "Household review center action owner is required");
    }
    this.reviewCenter = options.reviewCenter;
    this.store = options.store ?? new InMemoryHomeBatchActionStore();
    this.maxTargets = boundedMaxTargets(options.maxTargets);
  }

  async submit(command: HomeBatchActionCommand): Promise<HomeBatchActionResult> {
    const normalized = validateCommand(command, this.maxTargets);
    const fingerprint = fingerprintFor(normalized);
    const previous = this.readRecord(normalized.requestId);
    if (previous !== undefined) {
      assertSameFingerprint(previous, fingerprint);
      return cloneResult(previous.result);
    }

    const pending = this.inFlight.get(normalized.requestId);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) {
        throw new HomeBatchActionError("idempotency_conflict", "Batch request id already names another command");
      }
      return pending.promise;
    }

    const promise = this.submitNew(normalized, fingerprint);
    this.inFlight.set(normalized.requestId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(normalized.requestId)?.promise === promise) {
        this.inFlight.delete(normalized.requestId);
      }
    }
  }

  request(command: HomeBatchActionCommand): Promise<HomeBatchActionResult> {
    return this.submit(command);
  }

  private async submitNew(
    command: HomeBatchActionCommand,
    fingerprint: string,
  ): Promise<HomeBatchActionResult> {
    const currentDescriptors = this.resolveDescriptors(command);
    const items = await Promise.all(command.capabilityIds.map(async (capabilityId) => {
      const descriptor = currentDescriptors.get(capabilityId);
      if (descriptor === undefined) {
        throw new HomeBatchActionError("descriptor_unavailable", "Target descriptor is unavailable", capabilityId);
      }
      const targetRequestId = targetRequestIdFor(command.requestId, capabilityId);
      const request = {
        requestId: targetRequestId,
        capabilityId,
        summary: descriptor.summary ?? descriptor.actionLabel ?? descriptor.label ?? "家庭动作",
        action: descriptor.action,
        actor: command.actor,
        source: "member" as const,
      } satisfies RequestHouseholdActionInput;
      try {
        const result = await this.reviewCenter.requestAction(request);
        return projectItem(capabilityId, targetRequestId, descriptor, result);
      } catch {
        return {
          capabilityId,
          requestId: targetRequestId,
          policyClass: descriptor.policyClass,
          status: "unknown" as const,
          reason: "action_owner_unavailable",
          verification: "unknown" as const,
        } satisfies HomeBatchActionItem;
      }
    }));
    const result: HomeBatchActionResult = {
      requestId: command.requestId,
      items,
      counts: countsFor(items),
    };
    this.saveRecord({ requestId: command.requestId, fingerprint, result });
    return result;
  }

  private resolveDescriptors(command: HomeBatchActionCommand): ReadonlyMap<string, HouseholdActionDescriptor> {
    const resolved = new Map<string, HouseholdActionDescriptor>();
    for (const target of command.targets) {
      let current: HouseholdActionDescriptor | undefined;
      try {
        current = this.reviewCenter.actionDescriptorFor(target.capabilityId);
      } catch {
        current = undefined;
      }
      if (current === undefined || !descriptorMatches(target.descriptor, current)) {
        throw new HomeBatchActionError(
          "descriptor_unavailable",
          "Target descriptor is unknown, unsupported, or stale",
          target.capabilityId,
        );
      }
      resolved.set(target.capabilityId, cloneDescriptor(current));
    }
    return resolved;
  }

  private readRecord(requestId: string): HomeBatchActionRecord | undefined {
    try {
      const record = this.store.find(requestId);
      return record === undefined ? undefined : cloneRecord(record);
    } catch (error) {
      if (error instanceof HomeBatchActionError) throw error;
      throw new HomeBatchActionError("persistence_failed", "Batch idempotency state is unavailable");
    }
  }

  private saveRecord(record: HomeBatchActionRecord): void {
    try {
      this.store.save(record);
    } catch (error) {
      if (error instanceof HomeBatchActionError) throw error;
      throw new HomeBatchActionError("persistence_failed", "Batch idempotency state could not be saved");
    }
  }
}

export interface HomeBatchActionServiceOptions {
  readonly reviewCenter?: HomeBatchActionReviewCenterPort;
  readonly store?: HomeBatchActionStore;
  readonly path?: string;
  readonly maxTargets?: number;
}

/** Cordis integration supplies the existing review center and an explicit durable store. */
export class HomeBatchActionService extends Service {
  private readonly runner: HomeBatchActionRunner;
  private readonly store: HomeBatchActionStore;

  constructor(ctx: Context, options: HomeBatchActionServiceOptions = {}) {
    super(ctx, "homeBatchActions");
    const reviewCenter = options.reviewCenter
      ?? (ctx.get("homeReviewCenter") as unknown as HomeBatchActionReviewCenterPort | undefined);
    if (reviewCenter === undefined) {
      throw new HomeBatchActionError("review_center_unavailable", "Household review center action owner is required");
    }
    this.store = options.store
      ?? (options.path === undefined ? new InMemoryHomeBatchActionStore() : new SqliteHomeBatchActionStore(options.path));
    this.runner = new HomeBatchActionRunner({
      reviewCenter,
      store: this.store,
      ...(options.maxTargets === undefined ? {} : { maxTargets: options.maxTargets }),
    });
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-batch-actions.close");
  }

  submit(command: HomeBatchActionCommand): Promise<HomeBatchActionResult> {
    return this.runner.submit(command);
  }

  request(command: HomeBatchActionCommand): Promise<HomeBatchActionResult> {
    return this.runner.submit(command);
  }
}

function boundedMaxTargets(value: unknown): number {
  if (value === undefined) return MAX_BATCH_TARGETS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_TARGETS) {
    throw new HomeBatchActionError("invalid_command", "Batch target limit is invalid");
  }
  return value;
}

function validateCommand(value: unknown, maxTargets: number): HomeBatchActionCommand {
  if (!isRecord(value) || !hasOnlyKeys(value, ["requestId", "capabilityIds", "actor", "targets"])) {
    throw new HomeBatchActionError("invalid_command", "Batch command fields are invalid");
  }
  const requestId = boundedIdentifier(value.requestId, MAX_REQUEST_ID_LENGTH, "request id");
  if (!Array.isArray(value.capabilityIds) || value.capabilityIds.length < 1 || value.capabilityIds.length > maxTargets) {
    throw new HomeBatchActionError("invalid_command", "Batch capability ids are invalid");
  }
  const capabilityIds = value.capabilityIds.map((candidate) => boundedIdentifier(candidate, MAX_CAPABILITY_ID_LENGTH, "capability id"));
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    throw new HomeBatchActionError("duplicate_target", "Batch capability ids are unique");
  }
  const actor = validateActor(value.actor);
  if (!Array.isArray(value.targets) || value.targets.length !== capabilityIds.length) {
    throw new HomeBatchActionError("invalid_command", "Batch targets match capability ids");
  }
  const targets = value.targets.map((candidate, index) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["capabilityId", "descriptor"])) {
      throw new HomeBatchActionError("invalid_command", "Batch target fields are invalid");
    }
    const capabilityId = boundedIdentifier(candidate.capabilityId, MAX_CAPABILITY_ID_LENGTH, "capability id");
    if (capabilityId !== capabilityIds[index]) {
      throw new HomeBatchActionError("invalid_command", "Batch target order matches capability ids", capabilityId);
    }
    return {
      capabilityId,
      descriptor: validateDescriptor(candidate.descriptor),
    };
  });
  return { requestId, capabilityIds, actor, targets };
}

function validateActor(value: unknown): OneShotActionActor {
  if (!isRecord(value) || !hasOnlyKeys(value, ["principalId", "role", "present", "device"])) {
    throw new HomeBatchActionError("unauthorized_actor", "Batch actions require an authenticated actor");
  }
  const principalId = boundedPrincipalId(value.principalId);
  if (value.role !== "admin"
    && value.role !== "adult_member"
    && value.role !== "member"
    && value.role !== "child"
    && value.role !== "guest") {
    throw new HomeBatchActionError("unauthorized_actor", "Batch actions require a household member actor");
  }
  if (value.present !== true || !isRecord(value.device) || !hasOnlyKeys(value.device, ["kind", "boundPrincipalId"])) {
    throw new HomeBatchActionError("unauthorized_actor", "Batch actions require a present authenticated actor");
  }
  if (value.device.kind !== "private" && value.device.kind !== "shared") {
    throw new HomeBatchActionError("unauthorized_actor", "Batch actions require a recognized household device");
  }
  if (value.device.kind === "private" && value.device.boundPrincipalId !== principalId) {
    throw new HomeBatchActionError("unauthorized_actor", "Private devices bind to the authenticated actor");
  }
  return {
    principalId,
    role: value.role,
    present: true,
    device: value.device.kind === "private"
      ? { kind: "private", boundPrincipalId: principalId }
      : { kind: "shared" },
  };
}

function validateDescriptor(value: unknown): HomeBatchActionDescriptor {
  if (!isRecord(value) || !hasOnlyKeys(value, ["action", "reversible", "label", "actionLabel", "summary", "value", "policyClass"])) {
    throw new HomeBatchActionError("invalid_command", "Batch action descriptor fields are invalid");
  }
  const action = validateAction(value.action);
  if (value.reversible !== undefined && typeof value.reversible !== "boolean") {
    throw new HomeBatchActionError("invalid_command", "Batch action reversibility is invalid");
  }
  const label = optionalBoundedText(value.label, MAX_LABEL_LENGTH, "action label");
  const actionLabel = optionalBoundedText(value.actionLabel, MAX_ACTION_LABEL_LENGTH, "action label");
  const summary = optionalBoundedText(value.summary, MAX_SUMMARY_LENGTH, "action summary");
  const displayValue = optionalBoundedText(value.value, MAX_VALUE_LENGTH, "action value");
  if (value.policyClass !== undefined && !isPolicyClass(value.policyClass)) {
    throw new HomeBatchActionError("invalid_command", "Batch action policy class is invalid");
  }
  return {
    action,
    ...(value.reversible === undefined ? {} : { reversible: value.reversible }),
    ...(label === undefined ? {} : { label }),
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(summary === undefined ? {} : { summary }),
    ...(displayValue === undefined ? {} : { value: displayValue }),
    ...(value.policyClass === undefined ? {} : { policyClass: value.policyClass }),
  };
}

function validateAction(value: unknown): OneShotAction {
  if (!isRecord(value)) throw new HomeBatchActionError("invalid_command", "Batch action is invalid");
  if (value.kind === "set_boolean" && hasOnlyKeys(value, ["kind", "value"]) && typeof value.value === "boolean") {
    return { kind: "set_boolean", value: value.value };
  }
  if (value.kind === "set_level"
    && hasOnlyKeys(value, ["kind", "level"])
    && typeof value.level === "number"
    && Number.isFinite(value.level)
    && value.level >= 0
    && value.level <= 1) {
    return { kind: "set_level", level: value.level };
  }
  if (value.kind === "play_media"
    && hasOnlyKeys(value, ["kind", "mediaRef", "queueMode"])
    && typeof value.mediaRef === "string"
    && MEDIA_REF_PATTERN.test(value.mediaRef)
    && (value.queueMode === "replace_and_play" || value.queueMode === "play_next" || value.queueMode === "add_to_queue")) {
    return { kind: "play_media", mediaRef: value.mediaRef, queueMode: value.queueMode };
  }
  if (value.kind === "stop_media" && hasOnlyKeys(value, ["kind"])) return { kind: "stop_media" };
  throw new HomeBatchActionError("invalid_command", "Batch action is unsupported");
}

function descriptorMatches(candidate: HomeBatchActionDescriptor, current: HouseholdActionDescriptor): boolean {
  let normalizedCurrent: HomeBatchActionDescriptor;
  try {
    normalizedCurrent = validateDescriptor(current);
  } catch {
    return false;
  }
  if (!isPolicyClass(normalizedCurrent.policyClass)) return false;
  const candidateKeys = Object.keys(candidate).filter((key) => key !== "policyClass").sort();
  const currentKeys = Object.keys(normalizedCurrent).filter((key) => key !== "policyClass").sort();
  if (JSON.stringify(candidateKeys) !== JSON.stringify(currentKeys)) return false;
  for (const key of candidateKeys) {
    if (!sameValue(candidate[key as keyof HomeBatchActionDescriptor], normalizedCurrent[key as keyof HomeBatchActionDescriptor])) {
      return false;
    }
  }
  return candidate.policyClass === undefined || candidate.policyClass === normalizedCurrent.policyClass;
}

function cloneDescriptor(descriptor: HouseholdActionDescriptor): HouseholdActionDescriptor {
  return JSON.parse(JSON.stringify(descriptor)) as HouseholdActionDescriptor;
}

function projectItem(
  capabilityId: string,
  requestId: string,
  descriptor: HouseholdActionDescriptor,
  result: OneShotActionResult,
): HomeBatchActionItem {
  const ticket = result.ticket;
  const boundedTicketId = isBoundedId(ticket.id) ? ticket.id : undefined;
  const ticketMatches = boundedTicketId !== undefined
    && ticket.requestId === requestId
    && ticket.capabilityId === capabilityId
    && sameValue(ticket.action, descriptor.action)
    && ticket.policyClass === descriptor.policyClass
    && ticket.status === result.status
    && policyResultMatches(descriptor.policyClass, result.status);
  if (!ticketMatches) {
    return {
      capabilityId,
      requestId,
      policyClass: descriptor.policyClass,
      status: "unknown",
      ticketId: boundedTicketId,
      reason: "action_owner_result_mismatch",
      verification: "unknown",
    };
  }
  const status = statusFor(result.status);
  return {
    capabilityId,
    requestId,
    policyClass: descriptor.policyClass,
    status,
    ticketId: boundedTicketId,
    reason: outputReason(result.reason ?? ticket.resultReason, status),
    verification: status,
  };
}

function policyResultMatches(
  policyClass: ActionAuthorityPolicyClass,
  status: OneShotActionResult["status"],
): boolean {
  if (policyClass === "direct") return status !== "pending_confirmation";
  return status !== "verified";
}

function statusFor(status: OneShotActionResult["status"]): HomeBatchActionStatus {
  if (status === "verified") return "verified";
  if (status === "pending_confirmation") return "pending_confirmation";
  if (status === "failed" || status === "rejected" || status === "expired") return "failed";
  return "unknown";
}

function defaultReason(status: HomeBatchActionStatus): string {
  if (status === "verified") return "verified";
  if (status === "pending_confirmation") return "confirmation_required";
  if (status === "failed") return "action_failed";
  return "action_result_unknown";
}

function outputReason(value: unknown, status: HomeBatchActionStatus): string {
  return isBoundedReason(value) ? value : defaultReason(status);
}

function countsFor(items: readonly HomeBatchActionItem[]): HomeBatchActionCounts {
  return {
    total: items.length,
    verified: items.filter((item) => item.status === "verified").length,
    pending_confirmation: items.filter((item) => item.status === "pending_confirmation").length,
    failed: items.filter((item) => item.status === "failed").length,
    unknown: items.filter((item) => item.status === "unknown").length,
  };
}

function fingerprintFor(command: HomeBatchActionCommand): string {
  const canonical = {
    requestId: command.requestId,
    capabilityIds: command.capabilityIds,
    actor: command.actor,
    targets: command.capabilityIds.map((capabilityId) => command.targets.find((target) => target.capabilityId === capabilityId)),
  };
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function targetRequestIdFor(batchRequestId: string, capabilityId: string): string {
  const direct = `batch:${batchRequestId}:${capabilityId}`;
  if (!batchRequestId.includes(":")
    && !capabilityId.includes(":")
    && direct.length <= MAX_REQUEST_ID_LENGTH
    && CAPABILITY_ID_PATTERN.test(direct)) return direct;
  return `batch:${createHash("sha256").update(`${batchRequestId}\u0000${capabilityId}`).digest("hex")}`;
}

function assertSameFingerprint(record: HomeBatchActionRecord, fingerprint: string): void {
  if (record.fingerprint !== fingerprint) {
    throw new HomeBatchActionError("idempotency_conflict", "Batch request id already names another command");
  }
}

function validateRecord(value: unknown): asserts value is HomeBatchActionRecord {
  if (!isRecord(value)
    || !isBoundedId(value.requestId)
    || typeof value.fingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.fingerprint)
    || !isRecord(value.result)
    || value.result.requestId !== value.requestId
    || !Array.isArray(value.result.items)
    || value.result.items.length < 1
    || value.result.items.length > MAX_BATCH_TARGETS
    || !isRecord(value.result.counts)) {
    throw new HomeBatchActionError("persistence_failed", "Stored batch idempotency record is invalid");
  }
  const items = value.result.items;
  const capabilityIds = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)
      || !isBoundedId(item.capabilityId)
      || !isBoundedId(item.requestId)
      || !isPolicyClass(item.policyClass)
      || !isBatchStatus(item.status)
      || !isBoundedReason(item.reason)
      || item.verification !== item.status) {
      throw new HomeBatchActionError("persistence_failed", "Stored batch action item is invalid");
    }
    if (capabilityIds.has(item.capabilityId)) {
      throw new HomeBatchActionError("persistence_failed", "Stored batch action targets are duplicated");
    }
    capabilityIds.add(item.capabilityId);
    if (item.ticketId !== undefined && !isBoundedId(item.ticketId)) {
      throw new HomeBatchActionError("persistence_failed", "Stored batch action ticket id is invalid");
    }
  }
  const counts = value.result.counts;
  if (!isCount(counts.total)
    || !isCount(counts.verified)
    || !isCount(counts.pending_confirmation)
    || !isCount(counts.failed)
    || !isCount(counts.unknown)
    || counts.total !== items.length
    || counts.verified + counts.pending_confirmation + counts.failed + counts.unknown !== counts.total) {
    throw new HomeBatchActionError("persistence_failed", "Stored batch action counts are invalid");
  }
}

function cloneRecord(record: HomeBatchActionRecord): HomeBatchActionRecord {
  validateRecord(record);
  return JSON.parse(JSON.stringify(record)) as HomeBatchActionRecord;
}

function cloneResult(result: HomeBatchActionResult): HomeBatchActionResult {
  return cloneRecord({ requestId: result.requestId, fingerprint: "0".repeat(64), result }).result;
}

function isBatchStatus(value: unknown): value is HomeBatchActionStatus {
  return value === "verified" || value === "pending_confirmation" || value === "failed" || value === "unknown";
}

function isPolicyClass(value: unknown): value is ActionAuthorityPolicyClass {
  return value === "direct" || value === "confirmation" || value === "administrator";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedIdentifier(value: unknown, maxLength: number, label: string): string {
  if (!isBoundedId(value, maxLength)) {
    throw new HomeBatchActionError("invalid_command", `${label} is bounded and uses the neutral id alphabet`);
  }
  return value;
}

function isBoundedId(value: unknown, maxLength = MAX_REQUEST_ID_LENGTH): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength && CAPABILITY_ID_PATTERN.test(value);
}

function isBoundedReason(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_VALUE_LENGTH
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function boundedPrincipalId(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > MAX_REQUEST_ID_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new HomeBatchActionError("unauthorized_actor", "Actor principal id is bounded");
  }
  return value;
}

function optionalBoundedText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new HomeBatchActionError("invalid_command", `${label} is bounded`);
  }
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
