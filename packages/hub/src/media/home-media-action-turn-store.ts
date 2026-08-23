import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  HomeMediaClarificationOption,
  HomeMediaClarificationState,
  MediaClarificationReason,
  MediaClarificationSlot,
  MediaQueueMode,
} from "./home-media-conversation-service.js";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export type HomeMediaActionTurnStatus = "running" | "clarification" | "ticket" | "failed" | "cancelled";

export type HomeMediaActionTurnFailureReason =
  | "interrupted_before_action"
  | "agent_unavailable"
  | "timed_out"
  | "cancelled_before_action"
  | "invalid_result";

export type HomeMediaActionTurnRecord = {
  readonly id: string;
  /** Server-issued, 128-bit retry key. It never identifies a household member or device. */
  readonly idempotencyKey: string;
  /** Hub-owned deduplication identity for the one action request in this turn. */
  readonly requestId: string;
  /** Normalized local product text needed to render the turn after redirect or restart. */
  readonly question: string;
  readonly createdAt: string;
} & (
  | { readonly status: "running" }
  | {
      readonly status: "clarification";
      readonly clarification: HomeMediaClarificationState;
      readonly transitionedAt: string;
    }
  | { readonly status: "ticket"; readonly ticketId: string; readonly transitionedAt: string }
  | {
      readonly status: "failed" | "cancelled";
      readonly reason: HomeMediaActionTurnFailureReason;
      readonly transitionedAt: string;
    }
);

export interface HomeMediaActionTurnBeginResult {
  readonly outcome: "created" | "existing";
  readonly turn: HomeMediaActionTurnRecord;
}

export class HomeMediaActionIdempotencyConflictError extends Error {
  constructor() {
    super("Media action idempotency key conflicts with a different question");
    this.name = "HomeMediaActionIdempotencyConflictError";
  }
}

export type HomeMediaActionTurnEventType = "accepted" | "clarification" | "ticket" | "failed" | "cancelled";

/** A bounded, replayable lifecycle event. It contains no actor, device, or ticket details. */
export interface HomeMediaActionTurnEvent {
  readonly seq: number;
  readonly type: HomeMediaActionTurnEventType;
  readonly at: string;
}

export interface HomeMediaActionTurnStore {
  begin(input: {
    readonly createdAt: string;
    readonly idempotencyKey: string;
    /** Normalized and stored as local product state; its digest protects retry identity. */
    readonly question: string;
  }): HomeMediaActionTurnBeginResult;
  clarify(input: {
    readonly id: string;
    readonly clarification: HomeMediaClarificationState;
    readonly transitionedAt: string;
  }): boolean;
  ticket(input: { readonly id: string; readonly ticketId: string; readonly transitionedAt: string }): boolean;
  fail(input: {
    readonly id: string;
    readonly reason: Exclude<HomeMediaActionTurnFailureReason, "cancelled_before_action">;
    readonly transitionedAt: string;
  }): boolean;
  cancel(input: { readonly id: string; readonly transitionedAt: string }): boolean;
  get(id: string): HomeMediaActionTurnRecord | undefined;
  findByRequestId(requestId: string): HomeMediaActionTurnRecord | undefined;
  /** Reads a prior retry without creating an event or requiring an available model. */
  replay(input: { readonly idempotencyKey: string; readonly question: string }): HomeMediaActionTurnRecord | undefined;
  /** Running turns have no actor after a restart and need an explicit recovery decision. */
  recoverable(): readonly Extract<HomeMediaActionTurnRecord, { readonly status: "running" }>[];
  events(id: string, afterSeq?: number): readonly HomeMediaActionTurnEvent[];
  close(): void;
}

export interface SqliteHomeMediaActionTurnStoreOptions {
  readonly path: string;
  readonly idFactory?: () => string;
  /** Per-turn durable replay window. Older events are pruned while sequence stays monotonic. */
  readonly maxEventsPerTurn?: number;
}

type Row = Record<string, unknown>;

const EVENT_TYPES = ["accepted", "clarification", "ticket", "failed", "cancelled"] as const;
const FAILURE_REASONS = [
  "interrupted_before_action",
  "agent_unavailable",
  "timed_out",
  "cancelled_before_action",
  "invalid_result",
] as const satisfies readonly HomeMediaActionTurnFailureReason[];
const SLOTS = ["query", "mediaRef", "playerCapabilityId", "queueMode"] as const satisfies readonly MediaClarificationSlot[];
const CLARIFICATION_REASONS = ["missing", "ambiguous", "no_match", "not_playable"] as const satisfies readonly MediaClarificationReason[];
const QUEUE_MODES = ["replace_and_play", "play_next", "add_to_queue"] as const satisfies readonly MediaQueueMode[];
const MAX_TURN_ID_LENGTH = 180;
const MAX_REQUEST_ID_LENGTH = 200;
const MAX_TICKET_ID_LENGTH = 200;
const MAX_OPTION_COUNT = 16;
const MAX_OPTION_TEXT_LENGTH = 200;
const MAX_MEDIA_REF_LENGTH = 512;

/**
 * Private durable state for one explicit media action turn. This store owns no
 * principal, presence, device, secret, or ticket result; those remain at their owners.
 */
export class SqliteHomeMediaActionTurnStore implements HomeMediaActionTurnStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly idFactory: () => string;
  private readonly maxEventsPerTurn: number;
  private closed = false;

  constructor(options: SqliteHomeMediaActionTurnStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("home media action turn path is required");
    }
    this.path = options.path;
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxEventsPerTurn = boundedInteger(options.maxEventsPerTurn ?? 64, "media action turn event limit", 1, 256);
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.ensureSchema();
    this.ensurePrivateFiles();
  }

  begin(input: {
    readonly createdAt: string;
    readonly idempotencyKey: string;
    readonly question: string;
  }): HomeMediaActionTurnBeginResult {
    this.assertOpen();
    if (!isIsoTimestamp(input?.createdAt)) throw new TypeError("Invalid media action turn creation time");
    const idempotencyKey = validateIdempotencyKey(input?.idempotencyKey);
    const { question, questionHash } = validateQuestion(input?.question);
    const requestId = `media-action:${idempotencyKey}`;
    if (!isRequestId(requestId)) throw new TypeError("Invalid media action request id");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.replayByDigest(idempotencyKey, questionHash);
      if (turn !== undefined) {
        this.db.exec("COMMIT");
        return { outcome: "existing", turn };
      }
      const id = validateTurnId(this.idFactory());
      this.db.prepare(`INSERT INTO home_media_action_turns
        (turn_id, idempotency_key, request_id, question, question_hash, status, detail_json, created_at, transitioned_at)
        VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`)
        .run(id, idempotencyKey, requestId, question, questionHash, input.createdAt);
      this.insertEvent(id, "accepted", input.createdAt);
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return {
        outcome: "created",
        turn: { id, idempotencyKey, requestId, question, createdAt: input.createdAt, status: "running" },
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  clarify(input: {
    readonly id: string;
    readonly clarification: HomeMediaClarificationState;
    readonly transitionedAt: string;
  }): boolean {
    const clarification = validateClarification(input?.clarification);
    return this.transition({
      id: input?.id,
      status: "clarification",
      detail: clarification,
      transitionedAt: input?.transitionedAt,
    });
  }

  ticket(input: { readonly id: string; readonly ticketId: string; readonly transitionedAt: string }): boolean {
    const ticketId = validateTicketId(input?.ticketId);
    return this.transition({
      id: input?.id,
      status: "ticket",
      detail: { ticketId },
      transitionedAt: input?.transitionedAt,
    });
  }

  fail(input: {
    readonly id: string;
    readonly reason: Exclude<HomeMediaActionTurnFailureReason, "cancelled_before_action">;
    readonly transitionedAt: string;
  }): boolean {
    const reason = validateFailureReason(input?.reason);
    if (reason === "cancelled_before_action") throw new TypeError("Invalid media action turn failure reason");
    return this.transition({
      id: input?.id,
      status: "failed",
      detail: { reason },
      transitionedAt: input?.transitionedAt,
    });
  }

  cancel(input: { readonly id: string; readonly transitionedAt: string }): boolean {
    return this.transition({
      id: input?.id,
      status: "cancelled",
      detail: { reason: "cancelled_before_action" },
      transitionedAt: input?.transitionedAt,
    });
  }

  get(id: string): HomeMediaActionTurnRecord | undefined {
    this.assertOpen();
    validateTurnId(id);
    const row = this.db.prepare(`SELECT turn_id, idempotency_key, request_id, question, question_hash, status, detail_json, created_at, transitioned_at
      FROM home_media_action_turns WHERE turn_id = ?`).get(id) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  findByRequestId(requestId: string): HomeMediaActionTurnRecord | undefined {
    this.assertOpen();
    if (!isRequestId(requestId)) throw new TypeError("Invalid media action request id");
    const row = this.db.prepare(`SELECT turn_id, idempotency_key, request_id, question, question_hash, status, detail_json, created_at, transitioned_at
      FROM home_media_action_turns WHERE request_id = ?`).get(requestId) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  replay(input: { readonly idempotencyKey: string; readonly question: string }): HomeMediaActionTurnRecord | undefined {
    this.assertOpen();
    const idempotencyKey = validateIdempotencyKey(input?.idempotencyKey);
    const { questionHash } = validateQuestion(input?.question);
    return this.replayByDigest(idempotencyKey, questionHash);
  }

  recoverable(): readonly Extract<HomeMediaActionTurnRecord, { readonly status: "running" }>[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT turn_id, idempotency_key, request_id, question, question_hash, status, detail_json, created_at, transitioned_at
      FROM home_media_action_turns WHERE status = 'running' ORDER BY created_at ASC, turn_id ASC`).all() as Row[];
    return rows.map((row) => {
      const value = fromRow(row);
      if (value.status !== "running") throw new Error("Stored media action turn is corrupt");
      return value;
    });
  }

  events(id: string, afterSeq = 0): readonly HomeMediaActionTurnEvent[] {
    this.assertOpen();
    validateTurnId(id);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError("Invalid media action turn event cursor");
    const rows = this.db.prepare(`SELECT event_seq, lifecycle_kind, event_at
      FROM home_media_action_turn_events
      WHERE turn_id = ? AND event_seq > ? ORDER BY event_seq ASC`).all(id, afterSeq) as Row[];
    return rows.map(fromEventRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transition(input: {
    readonly id: unknown;
    readonly status: Exclude<HomeMediaActionTurnStatus, "running">;
    readonly detail: unknown;
    readonly transitionedAt: unknown;
  }): boolean {
    this.assertOpen();
    const id = validateTurnId(input.id);
    if (!isIsoTimestamp(input.transitionedAt)) throw new TypeError("Invalid media action turn transition time");
    const detailJson = JSON.stringify(input.detail);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT created_at, status FROM home_media_action_turns WHERE turn_id = ?`)
        .get(id) as Row | undefined;
      if (row?.status !== "running") {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (!isIsoTimestamp(row.created_at) || Date.parse(input.transitionedAt) < Date.parse(row.created_at)) {
        throw new TypeError("Invalid media action turn transition time");
      }
      const result = this.db.prepare(`UPDATE home_media_action_turns
        SET status = ?, detail_json = ?, transitioned_at = ?
        WHERE turn_id = ? AND status = 'running'`).run(input.status, detailJson, input.transitionedAt, id);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.insertEvent(id, input.status, input.transitionedAt);
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private insertEvent(id: string, type: HomeMediaActionTurnEventType, at: string): void {
    const row = this.db.prepare(`SELECT MAX(event_seq) AS event_seq
      FROM home_media_action_turn_events WHERE turn_id = ?`).get(id) as Row | undefined;
    const previous = row?.event_seq;
    const seq = previous === null || previous === undefined ? 1 : Number(previous) + 1;
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Media action turn event cursor exhausted");
    this.db.prepare(`INSERT INTO home_media_action_turn_events (turn_id, event_seq, lifecycle_kind, event_at)
      VALUES (?, ?, ?, ?)`).run(id, seq, type, at);
    const pruneAtOrBefore = seq - this.maxEventsPerTurn;
    if (pruneAtOrBefore > 0) {
      this.db.prepare(`DELETE FROM home_media_action_turn_events WHERE turn_id = ? AND event_seq <= ?`)
        .run(id, pruneAtOrBefore);
    }
  }

  private replayByDigest(idempotencyKey: string, questionHash: string): HomeMediaActionTurnRecord | undefined {
    const existing = this.db.prepare(`SELECT turn_id, idempotency_key, request_id, question, question_hash, status, detail_json, created_at, transitioned_at
      FROM home_media_action_turns WHERE idempotency_key = ?`).get(idempotencyKey) as Row | undefined;
    if (existing === undefined) return undefined;
    if (existing.question_hash !== questionHash) {
      throw new HomeMediaActionIdempotencyConflictError();
    }
    return fromRow(existing);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_media_action_turns (
        turn_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL UNIQUE,
        question TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'clarification', 'ticket', 'failed', 'cancelled')),
        detail_json TEXT,
        created_at TEXT NOT NULL,
        transitioned_at TEXT,
        CHECK ((status = 'running' AND detail_json IS NULL AND transitioned_at IS NULL)
          OR (status IN ('clarification', 'ticket', 'failed', 'cancelled')
            AND detail_json IS NOT NULL AND transitioned_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_media_action_turns_recoverable
        ON home_media_action_turns (status, created_at ASC, turn_id ASC);
      CREATE TABLE IF NOT EXISTS home_media_action_turn_events (
        turn_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
        lifecycle_kind TEXT NOT NULL CHECK (lifecycle_kind IN ('accepted', 'clarification', 'ticket', 'failed', 'cancelled')),
        event_at TEXT NOT NULL,
        PRIMARY KEY (turn_id, event_seq),
        FOREIGN KEY (turn_id) REFERENCES home_media_action_turns(turn_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_media_action_turn_events_cursor
        ON home_media_action_turn_events (turn_id, event_seq ASC);
    `);
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // The statement already rolled back; preserve the original failure.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Home media action turn store is closed");
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function fromRow(row: Row): HomeMediaActionTurnRecord {
  const id = row.turn_id;
  const idempotencyKey = row.idempotency_key;
  const requestId = row.request_id;
  const question = row.question;
  const status = row.status;
  const createdAt = row.created_at;
  if (!isTurnId(id) || !isIdempotencyKey(idempotencyKey) || !isRequestId(requestId)
    || !isQuestionHash(row.question_hash) || !isIsoTimestamp(createdAt)) {
    throw new Error("Stored media action turn is corrupt");
  }
  let normalizedQuestion: string;
  let questionHash: string;
  try {
    ({ question: normalizedQuestion, questionHash } = validateQuestion(question));
  } catch {
    throw new Error("Stored media action turn is corrupt");
  }
  if (normalizedQuestion !== question || questionHash !== row.question_hash) {
    throw new Error("Stored media action turn is corrupt");
  }
  if (requestId !== `media-action:${idempotencyKey}`) throw new Error("Stored media action turn is corrupt");
  if (status === "running" && row.detail_json === null && row.transitioned_at === null) {
    return { id, idempotencyKey, requestId, question: normalizedQuestion, createdAt, status };
  }
  if (!isStatus(status) || status === "running" || typeof row.detail_json !== "string" || !isIsoTimestamp(row.transitioned_at)
    || Date.parse(row.transitioned_at) < Date.parse(createdAt)) {
    throw new Error("Stored media action turn is corrupt");
  }
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    throw new Error("Stored media action turn is corrupt");
  }
  if (status === "clarification") {
    return { id, idempotencyKey, requestId, question: normalizedQuestion, createdAt, status, clarification: validateClarification(detail), transitionedAt: row.transitioned_at };
  }
  if (status === "ticket") {
    if (!isRecord(detail) || !hasExactKeys(detail, ["ticketId"]) || !isTicketId(detail.ticketId)) {
      throw new Error("Stored media action turn is corrupt");
    }
    return { id, idempotencyKey, requestId, question: normalizedQuestion, createdAt, status, ticketId: detail.ticketId, transitionedAt: row.transitioned_at };
  }
  if (!isRecord(detail) || !hasExactKeys(detail, ["reason"]) || !isFailureReason(detail.reason)) {
    throw new Error("Stored media action turn is corrupt");
  }
  if (status === "cancelled" && detail.reason !== "cancelled_before_action") {
    throw new Error("Stored media action turn is corrupt");
  }
  if (status === "failed" && detail.reason === "cancelled_before_action") {
    throw new Error("Stored media action turn is corrupt");
  }
  return { id, idempotencyKey, requestId, question: normalizedQuestion, createdAt, status, reason: detail.reason, transitionedAt: row.transitioned_at };
}

function fromEventRow(row: Row): HomeMediaActionTurnEvent {
  if (!Number.isSafeInteger(row.event_seq) || (row.event_seq as number) < 1
    || !isEventType(row.lifecycle_kind) || !isIsoTimestamp(row.event_at)) {
    throw new Error("Stored media action turn event is corrupt");
  }
  return { seq: row.event_seq as number, type: row.lifecycle_kind, at: row.event_at };
}

function validateClarification(value: unknown): HomeMediaClarificationState {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "slot", "reason", "options"])
    || value.status !== "clarification" || !isSlot(value.slot) || !isClarificationReason(value.reason)
    || !Array.isArray(value.options) || value.options.length > MAX_OPTION_COUNT) {
    throw new TypeError("Invalid media action turn clarification");
  }
  const slot = value.slot;
  const reason = value.reason;
  if (!isSlot(slot) || !isClarificationReason(reason)) {
    throw new TypeError("Invalid media action turn clarification");
  }
  const options = value.options.map((option) => validateClarificationOption(option, slot));
  return { status: "clarification", slot, reason, options };
}

function validateClarificationOption(value: unknown, slot: MediaClarificationSlot): HomeMediaClarificationOption {
  if (!isRecord(value) || !hasOnlyKeys(value, ["mediaRef", "playerCapabilityId", "queueMode", "title", "sourceLabel", "playable"])) {
    throw new TypeError("Invalid media action turn clarification option");
  }
  const mediaRef = value.mediaRef === undefined ? undefined : validateOpaqueReference(value.mediaRef, "media reference", MAX_MEDIA_REF_LENGTH);
  const playerCapabilityId = value.playerCapabilityId === undefined ? undefined : validateTicketId(value.playerCapabilityId);
  const queueMode = value.queueMode === undefined ? undefined : validateQueueMode(value.queueMode);
  const title = value.title === undefined ? undefined : validateDisplayText(value.title, "title");
  const sourceLabel = value.sourceLabel === undefined ? undefined : validateDisplayText(value.sourceLabel, "source label");
  const playable = value.playable === undefined ? undefined : value.playable;
  if (playable !== undefined && typeof playable !== "boolean") {
    throw new TypeError("Invalid media action turn clarification option");
  }
  if (slot === "query" || slot === "playerCapabilityId") {
    if (Object.keys(value).length !== 0) throw new TypeError("Invalid media action turn clarification option");
    return {};
  }
  if (slot === "queueMode") {
    if (!hasExactKeys(value, ["queueMode"]) || queueMode === undefined) {
      throw new TypeError("Invalid media action turn clarification option");
    }
    return { queueMode };
  }
  if (mediaRef === undefined || title === undefined || sourceLabel === undefined || playable === undefined
    || !hasExactKeys(value, ["mediaRef", "title", "sourceLabel", "playable"])) {
    throw new TypeError("Invalid media action turn clarification option");
  }
  return { mediaRef, title, sourceLabel, playable };
}

function validateTurnId(value: unknown): string {
  if (!isTurnId(value)) throw new TypeError("Invalid media action turn id");
  return value;
}

function validateIdempotencyKey(value: unknown): string {
  if (!isIdempotencyKey(value)) throw new TypeError("Invalid media action idempotency key");
  return value;
}

function validateQuestion(value: unknown): { readonly question: string; readonly questionHash: string } {
  if (typeof value !== "string") throw new TypeError("Invalid media action question");
  const question = value.trim();
  if (question.length < 1 || question.length > 1_000 || hasControlCharacter(question)) {
    throw new TypeError("Invalid media action question");
  }
  return {
    question,
    questionHash: createHash("sha256").update(question, "utf8").digest("hex"),
  };
}

function validateTicketId(value: unknown): string {
  if (!isTicketId(value)) throw new TypeError("Invalid media action turn ticket id");
  return value;
}

function validateOpaqueReference(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || hasControlCharacter(value)) {
    throw new TypeError(`Invalid media action turn ${label}`);
  }
  return value;
}

function validateDisplayText(value: unknown, label: string): string {
  return validateOpaqueReference(value, label, MAX_OPTION_TEXT_LENGTH);
}

function validateQueueMode(value: unknown): MediaQueueMode {
  if (!isQueueMode(value)) throw new TypeError("Invalid media action turn queue mode");
  return value;
}

function validateFailureReason(value: unknown): HomeMediaActionTurnFailureReason {
  if (!isFailureReason(value)) throw new TypeError("Invalid media action turn failure reason");
  return value;
}

function isTurnId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_TURN_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_REQUEST_ID_LENGTH
    && /^media-action:[a-f0-9]{32}$/.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isQuestionHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTicketId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_TICKET_ID_LENGTH
    && value.trim() === value && !hasControlCharacter(value);
}

function isEventType(value: unknown): value is HomeMediaActionTurnEventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is HomeMediaActionTurnStatus {
  return value === "running" || value === "clarification" || value === "ticket" || value === "failed" || value === "cancelled";
}

function isFailureReason(value: unknown): value is HomeMediaActionTurnFailureReason {
  return typeof value === "string" && (FAILURE_REASONS as readonly string[]).includes(value);
}

function isSlot(value: unknown): value is MediaClarificationSlot {
  return typeof value === "string" && (SLOTS as readonly string[]).includes(value);
}

function isClarificationReason(value: unknown): value is MediaClarificationReason {
  return typeof value === "string" && (CLARIFICATION_REASONS as readonly string[]).includes(value);
}

function isQueueMode(value: unknown): value is MediaQueueMode {
  return typeof value === "string" && (QUEUE_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
