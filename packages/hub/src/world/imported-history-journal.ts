import { DatabaseSync } from "node:sqlite";

import { canonicalHubJson } from "../foundation/canonical-json.js";
import {
  HistoryBindingSchema,
  HistoryCoverageReasonSchema,
  HistoryLiveCutSchema,
  HistoryPageSchema,
  HistoryRangeSchema,
  MAX_HISTORY_BINDINGS,
  MAX_HISTORY_RANGE_HOURS,
  MAX_HISTORY_RECORD_BYTES,
  MAX_HISTORY_RECORDS,
  stateEventSchema,
  type HistoryCoverageReason,
  type HistoryLiveCut,
  type HistoryPage,
  type HistoryRange,
  type StateEvent,
} from "@hob/bridge-contract";
import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";

export const HISTORY_MAX_LOOKBACK_HOURS = MAX_HISTORY_RANGE_HOURS;
export const HISTORY_MAX_BINDINGS = MAX_HISTORY_BINDINGS;
export const HISTORY_MAX_RECORDS = MAX_HISTORY_RECORDS;
export const HISTORY_MAX_NORMALIZED_EVENT_BYTES = MAX_HISTORY_RECORD_BYTES;
export const HISTORY_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_IMPORT_ID_LENGTH = 256;
const MAX_EPOCH_ID_LENGTH = 256;

export type { HistoryCoverageReason, HistoryPage };
export type ImportedHistoryLiveCut = HistoryLiveCut;

export interface ImportedHistoryCommitInput {
  readonly bridgeId: string;
  readonly page: HistoryPage;
  readonly expectedLiveCut: ImportedHistoryLiveCut;
}

export interface ImportedHistoryCommitResult {
  readonly committed: boolean;
  readonly storedRecordCount: number;
  readonly deduplicatedRecordCount: number;
  readonly reasons: readonly HistoryCoverageReason[];
}

export interface ImportedHistoryBinding {
  readonly nativeId: string;
  readonly nativeInstanceId: string;
}

export interface ImportedHistoryQuery {
  readonly bridgeId: string;
  readonly since: string;
  readonly until: string;
  readonly bindings: readonly ImportedHistoryBinding[];
  readonly limit: number;
}

export interface ImportedHistoryEvidenceRecord {
  readonly bridgeId: string;
  readonly importId: string;
  readonly historySeq: number;
  /** Exact normalized source range of the imported page, when available. */
  readonly sourceRange?: HistoryRange;
  readonly receivedAt: string;
  readonly liveCut: ImportedHistoryLiveCut;
  readonly state: StateEvent;
}

export interface ImportedHistoryGap {
  readonly bridgeId: string;
  readonly importId: string;
  readonly sourceRange: { readonly since: string; readonly until: string };
  readonly liveCut: ImportedHistoryLiveCut;
  readonly receivedAt: string;
  readonly reason: HistoryCoverageReason;
}

export interface ImportedHistoryEvidencePage {
  readonly records: readonly ImportedHistoryEvidenceRecord[];
  readonly gaps: readonly ImportedHistoryGap[];
  readonly truncated: boolean;
}

export interface ImportedHistoryJournalOptions {
  readonly maxBytes?: number;
  readonly clock?: () => string;
}

type SqlRow = Record<string, unknown>;

interface NormalizedPage {
  readonly importId: string;
  readonly sourceSince: string;
  readonly sourceUntil: string;
  readonly liveCut: ImportedHistoryLiveCut;
  readonly coverage: "partial" | "unavailable";
  readonly reasons: readonly HistoryCoverageReason[];
  readonly records: readonly NormalizedRecord[];
}

interface NormalizedRecord {
  readonly historySeq: number;
  readonly state: StateEvent;
  readonly stateJson: string;
  readonly canonicalKey: string;
  readonly conflictKey: string;
  readonly sourceTs?: string;
  readonly bytes: number;
}

interface StoredGap {
  readonly bridgeId: string;
  readonly importId: string;
  readonly sourceSince: string;
  readonly sourceUntil: string;
  readonly liveCut: ImportedHistoryLiveCut;
  readonly receivedAt: string;
  readonly reason: HistoryCoverageReason;
}

export class ImportedHistoryJournal {
  private readonly db: DatabaseSync;
  private readonly maxBytes: number;
  private readonly clock: () => string;
  private usedBytes: number;

  constructor(readonly path: string, options: ImportedHistoryJournalOptions = {}) {
    this.maxBytes = options.maxBytes ?? HISTORY_DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("imported history maxBytes must be a positive safe integer");
    }
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.initializeSchema();
    this.usedBytes = this.readUsedBytes();
    this.ensurePrivateFile();
  }

  commitPage(input: ImportedHistoryCommitInput): ImportedHistoryCommitResult {
    const inputValue = asRecord(input, "imported history commit");
    assertExactKeys(inputValue, ["bridgeId", "page", "expectedLiveCut"], "imported history commit");
    const bridgeId = validateBridgeId(inputValue.bridgeId);
    const page = validatePage(inputValue.page);
    const expectedLiveCut = validateLiveCut(inputValue.expectedLiveCut);
    if (page.liveCut.epochId !== expectedLiveCut.epochId || page.liveCut.lastSeq !== expectedLiveCut.lastSeq) {
      throw new Error("imported history live cut mismatch");
    }
    const receivedAt = validateTimestamp(this.clock(), "imported history receivedAt");
    const reasons = new Set<HistoryCoverageReason>(page.reasons);
    const pending: NormalizedRecord[] = [];
    let deduplicatedRecordCount = 0;
    const pageCanonicalKeys = new Set<string>();
    const pageSequenceKeys = new Set<number>();

    this.db.exec("BEGIN IMMEDIATE");
    const usedBytesBefore = this.usedBytes;
    try {
      for (const record of page.records) {
        const sequenceRow = this.db.prepare(`SELECT canonical_key FROM imported_history_events
          WHERE bridge_id = ? AND import_id = ? AND history_seq = ? LIMIT 1`)
          .get(bridgeId, page.importId, record.historySeq) as SqlRow | undefined;
        if (sequenceRow !== undefined) {
          if (String(sequenceRow.canonical_key) !== record.canonicalKey) {
            throw new Error("imported history import sequence replay mismatch");
          }
          deduplicatedRecordCount += 1;
          continue;
        }
        if (pageSequenceKeys.has(record.historySeq)) {
          throw new Error("imported history page sequence is duplicated");
        }
        pageSequenceKeys.add(record.historySeq);

        if (pageCanonicalKeys.has(record.canonicalKey)) {
          deduplicatedRecordCount += 1;
          continue;
        }
        pageCanonicalKeys.add(record.canonicalKey);

        const canonicalRow = this.db.prepare(`SELECT canonical_key FROM imported_history_events
          WHERE bridge_id = ? AND canonical_key = ? LIMIT 1`)
          .get(bridgeId, record.canonicalKey) as SqlRow | undefined;
        if (canonicalRow !== undefined) {
          deduplicatedRecordCount += 1;
          continue;
        }
        pending.push(record);
      }

      for (const record of page.records) {
        const existingConflictRows = this.db.prepare(`SELECT canonical_key FROM imported_history_events
          WHERE bridge_id = ? AND conflict_key = ?`).all(bridgeId, record.conflictKey) as SqlRow[];
        if (existingConflictRows.some((row) => String(row.canonical_key) !== record.canonicalKey)) {
          reasons.add("source_conflict");
        }
      }
      const pageConflictKeys = new Map<string, string>();
      for (const record of page.records) {
        const previous = pageConflictKeys.get(record.conflictKey);
        if (previous !== undefined && previous !== record.canonicalKey) reasons.add("source_conflict");
        pageConflictKeys.set(record.conflictKey, record.canonicalKey);
      }

      const gapRows = [...reasons].map((reason) => this.gapFor(
        bridgeId,
        page,
        receivedAt,
        reason,
      )).filter((gap) => !this.gapExists(gap));
      const additionalBytes = pending.reduce((sum, record) => sum + record.bytes, 0)
        + gapRows.reduce((sum, gap) => sum + this.gapBytes(gap), 0);
      if (this.usedBytes + additionalBytes > this.maxBytes) {
        const quotaGap = this.gapFor(bridgeId, page, receivedAt, "imported_quota");
        if (!this.quotaGapExists(quotaGap)) {
          const quotaGapBytes = this.gapBytes(quotaGap);
          if (this.usedBytes + quotaGapBytes <= this.maxBytes) {
            this.insertGap(quotaGap, quotaGapBytes);
          }
        }
        this.ensurePrivateFile();
        this.db.exec("COMMIT");
        return {
          committed: false,
          storedRecordCount: 0,
          deduplicatedRecordCount: 0,
          reasons: ["imported_quota"],
        };
      }

      for (const record of pending) {
        this.db.prepare(`INSERT INTO imported_history_events
          (bridge_id, import_id, history_seq, source_since, source_until,
           live_epoch_id, live_last_seq, received_at, source_ts, source_ts_quality,
           native_id, native_instance_id, state_json, canonical_key, conflict_key, bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            bridgeId,
            page.importId,
            record.historySeq,
            page.sourceSince,
            page.sourceUntil,
            page.liveCut.epochId,
            page.liveCut.lastSeq,
            receivedAt,
            record.sourceTs ?? null,
            record.state.time.sourceTsQuality,
            record.state.nativeId,
            record.state.nativeInstanceId,
            record.stateJson,
            record.canonicalKey,
            record.conflictKey,
            record.bytes,
          );
        this.usedBytes += record.bytes;
      }
      for (const gap of gapRows) this.insertGap(gap, this.gapBytes(gap));
      this.ensurePrivateFile();
      this.db.exec("COMMIT");
      return {
        committed: true,
        storedRecordCount: pending.length,
        deduplicatedRecordCount,
        reasons: [...reasons],
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original validation or SQLite error.
      }
      this.usedBytes = usedBytesBefore;
      throw error;
    }
  }

  queryImportedEvidence(query: ImportedHistoryQuery): ImportedHistoryEvidencePage {
    const normalized = validateQuery(query);
    const bindingClauses = normalized.bindings.map(() => "(native_id = ? AND native_instance_id = ?)");
    const bindingParams = normalized.bindings.flatMap((binding) => [binding.nativeId, binding.nativeInstanceId]);
    const rows = this.db.prepare(`SELECT bridge_id, import_id, history_seq,
        source_since, source_until, live_epoch_id, live_last_seq, received_at, state_json
      FROM imported_history_events
      WHERE bridge_id = ? AND source_ts >= ? AND source_ts < ?
        AND (${bindingClauses.join(" OR ")})
      ORDER BY source_ts ASC, native_id ASC, native_instance_id ASC,
        canonical_key ASC, import_id ASC, history_seq ASC
      LIMIT ?`).all(
      normalized.bridgeId,
      normalized.since,
      normalized.until,
      ...bindingParams,
      normalized.limit + 1,
    ) as SqlRow[];
    const gapRows = this.db.prepare(`SELECT bridge_id, import_id, source_since, source_until,
        live_epoch_id, live_last_seq, received_at, reason
      FROM imported_history_gaps
      WHERE bridge_id = ? AND source_since < ? AND source_until > ?
      ORDER BY id ASC LIMIT ?`).all(
      normalized.bridgeId,
      normalized.until,
      normalized.since,
      normalized.limit + 1,
    ) as SqlRow[];
    const records = rows.slice(0, normalized.limit).map((row) => this.recordFromRow(row));
    const gaps = gapRows.slice(0, normalized.limit).map((row) => this.gapFromRow(row));
    return {
      records,
      gaps,
      truncated: rows.length > normalized.limit || gapRows.length > normalized.limit,
    };
  }

  capacity(): { readonly usedBytes: number; readonly maxBytes: number; readonly remainingBytes: number } {
    return {
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      remainingBytes: Math.max(0, this.maxBytes - this.usedBytes),
    };
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS imported_history_events (
        bridge_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        history_seq INTEGER NOT NULL,
        source_since TEXT,
        source_until TEXT,
        live_epoch_id TEXT NOT NULL,
        live_last_seq INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        source_ts TEXT,
        source_ts_quality TEXT NOT NULL,
        native_id TEXT NOT NULL,
        native_instance_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        conflict_key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (bridge_id, import_id, history_seq)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS imported_history_events_canonical_key
        ON imported_history_events (bridge_id, canonical_key);
      CREATE INDEX IF NOT EXISTS imported_history_events_query
        ON imported_history_events (bridge_id, source_ts, native_id, native_instance_id);
      CREATE TABLE IF NOT EXISTS imported_history_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bridge_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        source_since TEXT NOT NULL,
        source_until TEXT NOT NULL,
        live_epoch_id TEXT NOT NULL,
        live_last_seq INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        UNIQUE (bridge_id, import_id, source_since, source_until, reason)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS imported_history_gaps_query
        ON imported_history_gaps (bridge_id, source_since, source_until);
      `);
      const columns = this.db.prepare("PRAGMA table_info(imported_history_events)").all() as SqlRow[];
      const columnNames = new Set(columns.map((column) => String(column.name)));
      if (!columnNames.has("source_since")) {
        this.db.exec("ALTER TABLE imported_history_events ADD COLUMN source_since TEXT");
      }
      if (!columnNames.has("source_until")) {
        this.db.exec("ALTER TABLE imported_history_events ADD COLUMN source_until TEXT");
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS imported_history_events_query
          ON imported_history_events (bridge_id, source_ts, native_id, native_instance_id);
        CREATE INDEX IF NOT EXISTS imported_history_gaps_query
          ON imported_history_gaps (bridge_id, source_since, source_until);
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original schema migration failure.
      }
      throw error;
    }
  }

  private gapFor(
    bridgeId: string,
    page: NormalizedPage,
    receivedAt: string,
    reason: HistoryCoverageReason,
  ): StoredGap {
    return {
      bridgeId,
      importId: page.importId,
      sourceSince: page.sourceSince,
      sourceUntil: page.sourceUntil,
      liveCut: page.liveCut,
      receivedAt,
      reason,
    };
  }

  private gapExists(gap: StoredGap): boolean {
    return this.db.prepare(`SELECT id FROM imported_history_gaps
      WHERE bridge_id = ? AND import_id = ? AND source_since = ? AND source_until = ? AND reason = ? LIMIT 1`)
      .get(gap.bridgeId, gap.importId, gap.sourceSince, gap.sourceUntil, gap.reason) !== undefined;
  }

  private quotaGapExists(gap: StoredGap): boolean {
    return this.db.prepare(`SELECT id FROM imported_history_gaps
      WHERE bridge_id = ? AND source_since = ? AND source_until = ? AND reason = ? LIMIT 1`)
      .get(gap.bridgeId, gap.sourceSince, gap.sourceUntil, gap.reason) !== undefined;
  }

  private gapBytes(gap: StoredGap): number {
    return Buffer.byteLength(JSON.stringify({
      bridgeId: gap.bridgeId,
      importId: gap.importId,
      sourceRange: { since: gap.sourceSince, until: gap.sourceUntil },
      liveCut: gap.liveCut,
      receivedAt: gap.receivedAt,
      reason: gap.reason,
    }), "utf8");
  }

  private insertGap(gap: StoredGap, bytes: number): void {
    const result = this.db.prepare(`INSERT OR IGNORE INTO imported_history_gaps
      (bridge_id, import_id, source_since, source_until, live_epoch_id,
       live_last_seq, received_at, reason, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        gap.bridgeId,
        gap.importId,
        gap.sourceSince,
        gap.sourceUntil,
        gap.liveCut.epochId,
        gap.liveCut.lastSeq,
        gap.receivedAt,
        gap.reason,
        bytes,
      );
    if (Number(result.changes ?? 0) > 0) this.usedBytes += bytes;
  }

  private recordFromRow(row: SqlRow): ImportedHistoryEvidenceRecord {
    const parsed = JSON.parse(String(row.state_json)) as unknown;
    const state = stateEventSchema.safeParse(parsed);
    if (!state.success || state.data.origin !== "imported") {
      throw new Error("stored imported history state is invalid");
    }
    if (state.data.time.sourceTs !== undefined) {
      validateTimestamp(state.data.time.sourceTs, "stored imported history source timestamp");
    } else if (state.data.time.sourceTsQuality !== "none") {
      throw new Error("stored imported history timestamp quality is invalid");
    }
    const bridgeId = validateBridgeId(row.bridge_id);
    const importId = validateString(row.import_id, "stored imported history import id", MAX_IMPORT_ID_LENGTH);
    const historySeq = Number(row.history_seq);
    if (!Number.isSafeInteger(historySeq) || historySeq <= 0) {
      throw new Error("stored imported history sequence is invalid");
    }
    const sourceRange = optionalStoredRange(row.source_since, row.source_until);
    const receivedAt = validateTimestamp(row.received_at, "stored imported history receivedAt");
    const liveCut = validateLiveCut({ epochId: row.live_epoch_id, lastSeq: row.live_last_seq });
    return {
      bridgeId,
      importId,
      historySeq,
      ...(sourceRange === undefined ? {} : { sourceRange }),
      receivedAt,
      liveCut,
      state: state.data,
    };
  }

  private gapFromRow(row: SqlRow): ImportedHistoryGap {
    const reason = validateReason(row.reason);
    const bridgeId = validateBridgeId(row.bridge_id);
    const importId = validateString(row.import_id, "stored imported history import id", MAX_IMPORT_ID_LENGTH);
    const sourceRange = validateRange({ since: row.source_since, until: row.source_until }, "stored imported history source range");
    const receivedAt = validateTimestamp(row.received_at, "stored imported history receivedAt");
    const liveCut = validateLiveCut({ epochId: row.live_epoch_id, lastSeq: row.live_last_seq });
    return {
      bridgeId,
      importId,
      sourceRange,
      liveCut,
      receivedAt,
      reason,
    };
  }

  private readUsedBytes(): number {
    const row = this.db.prepare(`SELECT
      COALESCE((SELECT SUM(bytes) FROM imported_history_events), 0)
      + COALESCE((SELECT SUM(bytes) FROM imported_history_gaps), 0) AS used`).get() as SqlRow;
    return Number(row.used);
  }

  private ensurePrivateFile(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

function validatePage(page: unknown): NormalizedPage {
  const parsed = HistoryPageSchema.safeParse(page);
  if (!parsed.success) throw new TypeError(`history page is invalid: ${parsed.error.issues[0]?.message ?? "schema"}`);
  const value = parsed.data;
  const importId = validateString(value.importId, "history import id", MAX_IMPORT_ID_LENGTH);
  const range = validateRange(value.sourceRange, "history source range");
  const liveCut = validateLiveCut(value.liveCut);
  const reasons = value.reasons.map((reason) => validateReason(reason));
  if (new Set(reasons).size !== reasons.length) throw new TypeError("history page reasons are duplicated");
  if (value.coverage === "unavailable" && value.records.length > 0) {
    throw new TypeError("unavailable history page cannot contain records");
  }
  const records = value.records.map((record) => normalizeRecord(record, range.since, range.until));
  const sequences = new Set(records.map((record) => record.historySeq));
  if (sequences.size !== records.length) throw new TypeError("history page sequence is duplicated");
  return {
    importId,
    sourceSince: range.since,
    sourceUntil: range.until,
    liveCut,
    coverage: value.coverage,
    reasons,
    records,
  };
}

function normalizeRecord(
  record: HistoryPage["records"][number],
  sourceSince: string,
  sourceUntil: string,
): NormalizedRecord {
  const parsed = stateEventSchema.safeParse(record.state);
  if (!parsed.success) throw new TypeError("history record state is invalid");
  if (parsed.data.origin !== "imported") throw new TypeError("history record state must be imported");
  validateString(parsed.data.nativeId, "history native id", MAX_IDENTIFIER_LENGTH);
  validateString(parsed.data.nativeInstanceId, "history native instance id", MAX_IDENTIFIER_LENGTH);
  const sourceTs = parsed.data.time.sourceTs === undefined
    ? undefined
    : canonicalUtcTimestamp(parsed.data.time.sourceTs, "history source timestamp");
  if (sourceTs !== undefined) {
    if (sourceTs < sourceSince || sourceTs >= sourceUntil) {
      throw new RangeError("history source timestamp is outside source range");
    }
  }
  if ((sourceTs === undefined) !== (parsed.data.time.sourceTsQuality === "none")) {
    throw new TypeError("history source timestamp quality is inconsistent");
  }
  const state: StateEvent = parsed.data;
  const stateJson = JSON.stringify(state);
  const bytes = Buffer.byteLength(stateJson, "utf8");
  if (bytes > HISTORY_MAX_NORMALIZED_EVENT_BYTES) throw new RangeError("history record exceeds resource budget");
  const canonicalKey = canonicalHubJson([
    state.nativeId,
    state.nativeInstanceId,
    sourceTs ?? null,
    state.attrs,
  ]);
  const conflictKey = canonicalHubJson([state.nativeId, state.nativeInstanceId, sourceTs ?? null]);
  return {
    historySeq: record.historySeq,
    state,
    stateJson,
    canonicalKey,
    conflictKey,
    ...(sourceTs === undefined ? {} : { sourceTs }),
    bytes: Buffer.byteLength(JSON.stringify({ stateJson, canonicalKey, conflictKey }), "utf8"),
  };
}

function validateQuery(query: ImportedHistoryQuery): {
  readonly bridgeId: string;
  readonly since: string;
  readonly until: string;
  readonly bindings: readonly ImportedHistoryBinding[];
  readonly limit: number;
} {
  const value = asRecord(query, "history query");
  assertExactKeys(value, ["bridgeId", "since", "until", "bindings", "limit"], "history query");
  const bridgeId = validateString(value.bridgeId, "history query bridge id", MAX_IDENTIFIER_LENGTH);
  const range = validateRange({ since: value.since, until: value.until }, "history query range");
  if (!Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > HISTORY_MAX_BINDINGS) {
    throw new RangeError("history query bindings are unbounded");
  }
  const bindings = value.bindings.map((binding) => {
    const parsed = HistoryBindingSchema.safeParse(binding);
    if (!parsed.success) throw new TypeError("history binding is invalid");
    return {
      nativeId: validateString(parsed.data.nativeId, "history binding native id", MAX_IDENTIFIER_LENGTH),
      nativeInstanceId: validateString(parsed.data.nativeInstanceId, "history binding native instance id", MAX_IDENTIFIER_LENGTH),
    };
  });
  if (new Set(bindings.map((binding) => `${binding.nativeId}\u0000${binding.nativeInstanceId}`)).size !== bindings.length) {
    throw new TypeError("history query bindings are duplicated");
  }
  if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > HISTORY_MAX_RECORDS) {
    throw new RangeError("history query limit is invalid");
  }
  return { bridgeId, since: range.since, until: range.until, bindings, limit: Number(value.limit) };
}

function validateLiveCut(value: unknown): ImportedHistoryLiveCut {
  const parsed = HistoryLiveCutSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("history live cut is invalid");
  return {
    epochId: validateString(parsed.data.epochId, "history live epoch id", MAX_EPOCH_ID_LENGTH),
    lastSeq: parsed.data.lastSeq,
  };
}

function validateReason(value: unknown): HistoryCoverageReason {
  const parsed = HistoryCoverageReasonSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("history coverage reason is invalid");
  return parsed.data;
}

function validateRange(value: unknown, label: string): { readonly since: string; readonly until: string } {
  const parsed = HistoryRangeSchema.safeParse(value);
  if (!parsed.success) throw new RangeError(`${label} exceeds the bounded range`);
  return {
    since: canonicalUtcTimestamp(parsed.data.since, `${label} since`),
    until: canonicalUtcTimestamp(parsed.data.until, `${label} until`),
  };
}

function optionalStoredRange(since: unknown, until: unknown): HistoryRange | undefined {
  const hasSince = since !== null && since !== undefined;
  const hasUntil = until !== null && until !== undefined;
  if (!hasSince && !hasUntil) return undefined;
  if (!hasSince || !hasUntil) throw new Error("stored imported history source range is incomplete");
  return validateRange({ since, until }, "stored imported history source range");
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 64) {
    throw new TypeError(`${label} is invalid`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateBridgeId(value: unknown): string {
  return validateString(value, "history bridge id", MAX_IDENTIFIER_LENGTH);
}

function validateString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UTC_TIMESTAMP_CAPTURE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;
const CANONICAL_TIMESTAMP_FRACTION_DIGITS = 43;

function canonicalUtcTimestamp(value: unknown, label: string): string {
  const timestamp = validateTimestamp(value, label);
  const match = UTC_TIMESTAMP_CAPTURE_PATTERN.exec(timestamp);
  if (match === null) throw new TypeError(`${label} is invalid`);
  const fraction = (match[2] ?? "").padEnd(CANONICAL_TIMESTAMP_FRACTION_DIGITS, "0");
  if (fraction.length > CANONICAL_TIMESTAMP_FRACTION_DIGITS) throw new TypeError(`${label} is invalid`);
  return `${match[1]}.${fraction}Z`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError(`${label} contains unsupported fields`);
}
