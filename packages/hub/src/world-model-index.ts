import { DatabaseSync } from "node:sqlite";

import {
  ingestRecordSchema,
  type DeviceDescriptor,
  type Envelope,
  type IngestRecord,
  type JsonValue,
  type StateEvent,
} from "@hob/bridge-contract";
import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export type WorldModelFreshness = "fresh" | "stale-gap";
export type WorldModelDeviceValidity = "valid" | "present-but-invalid" | "invalid-source";

export interface WorldModelJournalGap {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: string;
}

export interface WorldModelConsistentWatermark {
  readonly epochId: string;
  readonly lastSeq: number;
}

export interface WorldModelConsistentBatch {
  readonly bridgeId: string;
  /** Canonical journal records; records after the supplied watermark are ignored. */
  readonly records: readonly IngestRecord[];
  /** Must point at a manifest-verified sync-complete in records. */
  readonly consistentWatermark: WorldModelConsistentWatermark;
  /** History gaps are evidence and make affected values stale, never removed. */
  readonly gaps?: readonly WorldModelJournalGap[];
  /**
   * The ingest boundary may have rejected native device/state envelopes while
   * still accepting the manifest. Those envelopes are intentionally absent
   * from the canonical journal projection, so their manifest counts are
   * treated as upper bounds for this trusted materialization seam.
   */
  readonly allowRejectedEvents?: boolean;
  /** Native IDs extracted from rejected replay envelopes; preserve their presence. */
  readonly rejectedNativeIds?: readonly string[];
}

export interface WorldModelIndexOptions {
  readonly path: string;
  /** Receipt-time bucket width used for numeric aggregates. */
  readonly bucketMs?: number;
  /** Minimum raw canonical journal rows preserved per bridge by retention. */
  readonly minimumRawRecords?: number;
  readonly minimumRawJournalRecords?: number;
}

export interface WorldModelApplyResult {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly freshness: WorldModelFreshness;
}

export interface WorldModelDevice {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly descriptor: DeviceDescriptor;
  readonly epochId: string;
  readonly seq: number;
  readonly freshness: WorldModelFreshness;
  readonly validity: WorldModelDeviceValidity;
}

export interface WorldModelLatestState {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly attrs: Record<string, JsonValue>;
  readonly sourceTs?: string;
  readonly sourceTsQuality: StateEvent["time"]["sourceTsQuality"];
  readonly origin: StateEvent["origin"];
  readonly receivedAt: string;
  readonly epochId: string;
  readonly seq: number;
  readonly freshness: WorldModelFreshness;
}

export interface WorldModelNumericAggregate {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly attribute: string;
  readonly bucketStart: string;
  readonly count: number;
  readonly last: number;
  readonly min: number;
  readonly max: number;
  readonly freshness: WorldModelFreshness;
}

export interface WorldModelStateQuery {
  readonly bridgeId?: string;
  readonly nativeId?: string;
  readonly nativeInstanceId?: string;
}

export interface WorldModelAggregateQuery extends WorldModelStateQuery {
  readonly attribute?: string;
  readonly bucketStart?: string;
}

export interface WorldModelRawJournalRecord {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly seq: number;
  readonly receivedAt: string;
  readonly envelope: Envelope;
  readonly compressed: boolean;
}

export interface WorldModelRetentionPolicy {
  readonly policyId: string;
  readonly mode: "delete" | "compress";
  readonly beforeReceivedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface WorldModelRetentionAudit {
  readonly policyId: string;
  readonly mode: WorldModelRetentionPolicy["mode"];
  readonly beforeReceivedAt: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly candidateCount: number;
  readonly affectedCount: number;
  readonly deletedCount: number;
  readonly compressedCount: number;
  readonly skippedMinimumCount: number;
  readonly appliedAt: string;
}

export type WorldModelIndexErrorCode =
  | "invalid_batch"
  | "invalid_record"
  | "inconsistent_snapshot"
  | "native_payload_rejected"
  | "retention_policy_invalid"
  | "retention_policy_reused";

export class WorldModelIndexError extends Error {
  constructor(readonly code: WorldModelIndexErrorCode, message: string) {
    super(message);
    this.name = "WorldModelIndexError";
  }
}

interface SqlRow extends Record<string, unknown> {}

const DEFAULT_BUCKET_MS = 60 * 60 * 1_000;
const NATIVE_PAYLOAD_KEYS = new Set([
  "entity_id",
  "attributes",
  "event_type",
  "new_state",
  "old_state",
  "last_changed",
  "last_updated",
  "context",
  "service_data",
]);

/**
 * Durable read model built from a verified canonical journal cut. This class
 * deliberately has no bridge runtime dependency: a caller supplies only
 * canonical records and the watermark whose sync-complete was verified.
 */
export class WorldModelIndex {
  private readonly db: DatabaseSync;
  private readonly bucketMs: number;
  private readonly minimumRawRecords: number;
  readonly path: string;

  constructor(options: WorldModelIndexOptions);
  constructor(path: string, options?: Omit<WorldModelIndexOptions, "path">);
  constructor(pathOrOptions: string | WorldModelIndexOptions, options: Omit<WorldModelIndexOptions, "path"> = {}) {
    const normalized = typeof pathOrOptions === "string" ? { ...options, path: pathOrOptions } : pathOrOptions;
    if (typeof normalized.path !== "string" || normalized.path.trim() === "") {
      throw new RangeError("world model index path is required");
    }
    this.path = normalized.path;
    this.bucketMs = positiveSafeInteger(normalized.bucketMs ?? DEFAULT_BUCKET_MS, "bucketMs");
    this.minimumRawRecords = nonNegativeSafeInteger(
      normalized.minimumRawRecords ?? normalized.minimumRawJournalRecords ?? 0,
      "minimumRawRecords",
    );
    this.db = new DatabaseSync(normalized.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_model_journal (
        bridge_id TEXT NOT NULL,
        epoch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        compressed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bridge_id, epoch_id, seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_devices (
        bridge_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        epoch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        freshness TEXT NOT NULL,
        validity TEXT NOT NULL DEFAULT 'valid',
        PRIMARY KEY (bridge_id, native_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_latest_states (
        bridge_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        native_instance_id TEXT NOT NULL,
        attrs_json TEXT NOT NULL,
        source_ts TEXT,
        source_ts_quality TEXT NOT NULL,
        origin TEXT NOT NULL,
        received_at TEXT NOT NULL,
        epoch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        freshness TEXT NOT NULL,
        PRIMARY KEY (bridge_id, native_id, native_instance_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_numeric_buckets (
        bridge_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        native_instance_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        last_value REAL NOT NULL,
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        freshness TEXT NOT NULL,
        PRIMARY KEY (bridge_id, native_id, native_instance_id, attribute, bucket_start)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_watermarks (
        bridge_id TEXT PRIMARY KEY,
        epoch_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        freshness TEXT NOT NULL,
        committed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bridge_id TEXT NOT NULL,
        epoch_id TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (bridge_id, epoch_id, from_seq, to_seq, reason)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS world_model_retention_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        before_received_at TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        candidate_count INTEGER NOT NULL,
        affected_count INTEGER NOT NULL,
        deleted_count INTEGER NOT NULL,
        compressed_count INTEGER NOT NULL,
        skipped_minimum_count INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    this.ensureDeviceValidityColumn();
    this.ensurePrivateFile(normalized.path);
  }

  applyConsistentBatch(batch: WorldModelConsistentBatch): WorldModelApplyResult {
    const prepared = prepareBatch(batch);
    const prior = this.watermarkRow(prepared.bridgeId);
    if (prior?.epochId === prepared.watermark.epochId && prior.lastSeq === prepared.watermark.lastSeq) {
      this.assertReplayIdentity(prepared.records);
      return {
        bridgeId: prepared.bridgeId,
        epochId: prepared.watermark.epochId,
        lastSeq: prepared.watermark.lastSeq,
        applied: false,
        duplicate: true,
        freshness: prior.freshness as WorldModelFreshness,
      };
    }
    if (prior?.epochId === prepared.watermark.epochId && prepared.watermark.lastSeq < prior.lastSeq) {
      throw new WorldModelIndexError("inconsistent_snapshot", "A consistent watermark cannot move backwards within an epoch");
    }

    const committedAt = new Date().toISOString();
    const freshness = batchFreshness(prepared.bridgeId, prepared.watermark, prepared.gaps);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const descriptorIds = new Set<string>();
      const rejectedNativeIds = new Set(prepared.rejectedNativeIds);
      for (const item of prepared.records) {
        const event = item.envelope.event;
        if (event.kind === "device-upserted") descriptorIds.add(event.device.nativeId);
        const inserted = this.insertJournalRecord(item);
        if (!inserted) continue;
        if (event.kind === "device-upserted") {
          this.upsertDevice(
            item,
            event.device,
            eventFreshness(item, prepared.gaps, prepared.watermark),
            rejectedNativeIds.has(event.device.nativeId) ? "invalid-source" : "valid",
          );
        } else if (event.kind === "state") {
          this.upsertState(item, event.state, eventFreshness(item, prepared.gaps, prepared.watermark));
          this.updateNumericBuckets(item, event.state, eventFreshness(item, prepared.gaps, prepared.watermark));
        }
      }

      this.preserveRejectedPresence(
        prepared.bridgeId,
        prepared.rejectedNativeIds,
        descriptorIds,
        prepared.watermark,
        freshness,
      );
      this.removeDevicesNotInSnapshot(
        prepared.bridgeId,
        new Set([...descriptorIds, ...prepared.rejectedNativeIds]),
      );
      for (const gap of prepared.gaps) this.insertGap(gap, committedAt);
      this.db.prepare(`INSERT INTO world_model_watermarks
        (bridge_id, epoch_id, last_seq, freshness, committed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bridge_id) DO UPDATE SET
          epoch_id = excluded.epoch_id,
          last_seq = excluded.last_seq,
          freshness = excluded.freshness,
          committed_at = excluded.committed_at`).run(
        prepared.bridgeId,
        prepared.watermark.epochId,
        prepared.watermark.lastSeq,
        freshness,
        committedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }

    return {
      bridgeId: prepared.bridgeId,
      epochId: prepared.watermark.epochId,
      lastSeq: prepared.watermark.lastSeq,
      applied: true,
      duplicate: false,
      freshness,
    };
  }

  devices(bridgeId?: string): WorldModelDevice[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare("SELECT bridge_id, native_id, descriptor_json, epoch_id, seq, freshness, validity FROM world_model_devices ORDER BY bridge_id, native_id").all()
      : this.db.prepare("SELECT bridge_id, native_id, descriptor_json, epoch_id, seq, freshness, validity FROM world_model_devices WHERE bridge_id = ? ORDER BY native_id").all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({
      bridgeId: String(row.bridge_id),
      nativeId: String(row.native_id),
      descriptor: JSON.parse(String(row.descriptor_json)) as DeviceDescriptor,
      epochId: String(row.epoch_id),
      seq: Number(row.seq),
      freshness: String(row.freshness) as WorldModelFreshness,
      validity: String(row.validity) as WorldModelDeviceValidity,
    }));
  }

  latestState(bridgeId: string, nativeId: string, nativeInstanceId: string): WorldModelLatestState | undefined {
    const row = this.db.prepare(`SELECT bridge_id, native_id, native_instance_id, attrs_json,
      source_ts, source_ts_quality, origin, received_at, epoch_id, seq, freshness
      FROM world_model_latest_states
      WHERE bridge_id = ? AND native_id = ? AND native_instance_id = ?`).get(
      bridgeId,
      nativeId,
      nativeInstanceId,
    ) as SqlRow | undefined;
    return row === undefined ? undefined : rowToLatestState(row);
  }

  latestStates(query: WorldModelStateQuery = {}): WorldModelLatestState[] {
    const { sql, params } = whereQuery("world_model_latest_states", query);
    const rows = this.db.prepare(`SELECT bridge_id, native_id, native_instance_id, attrs_json,
      source_ts, source_ts_quality, origin, received_at, epoch_id, seq, freshness
      FROM world_model_latest_states${sql} ORDER BY bridge_id, native_id, native_instance_id`).all(...params) as SqlRow[];
    return rows.map(rowToLatestState);
  }

  numericAggregates(query: WorldModelAggregateQuery = {}): WorldModelNumericAggregate[] {
    const { sql, params } = whereQuery("world_model_numeric_buckets", query);
    const rows = this.db.prepare(`SELECT bridge_id, native_id, native_instance_id, attribute,
      bucket_start, sample_count, last_value, min_value, max_value, freshness
      FROM world_model_numeric_buckets${sql} ORDER BY bridge_id, native_id, native_instance_id, attribute, bucket_start`).all(...params) as SqlRow[];
    return rows.map((row) => ({
      bridgeId: String(row.bridge_id),
      nativeId: String(row.native_id),
      nativeInstanceId: String(row.native_instance_id),
      attribute: String(row.attribute),
      bucketStart: String(row.bucket_start),
      count: Number(row.sample_count),
      last: Number(row.last_value),
      min: Number(row.min_value),
      max: Number(row.max_value),
      freshness: String(row.freshness) as WorldModelFreshness,
    }));
  }

  consistentWatermark(bridgeId: string): WorldModelConsistentWatermark | undefined {
    const row = this.watermarkRow(bridgeId);
    return row === undefined ? undefined : { epochId: row.epochId, lastSeq: row.lastSeq };
  }

  freshness(bridgeId: string): WorldModelFreshness | undefined {
    return this.watermarkRow(bridgeId)?.freshness as WorldModelFreshness | undefined;
  }

  rawJournalRecords(bridgeId?: string): WorldModelRawJournalRecord[] {
    const rows = (bridgeId === undefined
      ? this.db.prepare(`SELECT bridge_id, epoch_id, seq, received_at, envelope_json, compressed
        FROM world_model_journal ORDER BY bridge_id, epoch_id, seq`).all()
      : this.db.prepare(`SELECT bridge_id, epoch_id, seq, received_at, envelope_json, compressed
        FROM world_model_journal WHERE bridge_id = ? ORDER BY epoch_id, seq`).all(bridgeId)) as SqlRow[];
    return rows.map((row) => ({
      bridgeId: String(row.bridge_id),
      epochId: String(row.epoch_id),
      seq: Number(row.seq),
      receivedAt: String(row.received_at),
      envelope: JSON.parse(String(row.envelope_json)) as Envelope,
      compressed: Number(row.compressed) === 1,
    }));
  }

  retentionAudits(): WorldModelRetentionAudit[] {
    const rows = this.db.prepare(`SELECT policy_id, mode, before_received_at, requested_by,
      reason, candidate_count, affected_count, deleted_count, compressed_count,
      skipped_minimum_count, applied_at FROM world_model_retention_audit ORDER BY id`).all() as SqlRow[];
    return rows.map((row) => ({
      policyId: String(row.policy_id),
      mode: String(row.mode) as WorldModelRetentionPolicy["mode"],
      beforeReceivedAt: String(row.before_received_at),
      requestedBy: String(row.requested_by),
      reason: String(row.reason),
      candidateCount: Number(row.candidate_count),
      affectedCount: Number(row.affected_count),
      deletedCount: Number(row.deleted_count),
      compressedCount: Number(row.compressed_count),
      skippedMinimumCount: Number(row.skipped_minimum_count),
      appliedAt: String(row.applied_at),
    }));
  }

  applyRetention(policy: WorldModelRetentionPolicy): WorldModelRetentionAudit {
    validateRetentionPolicy(policy);
    const existing = this.db.prepare("SELECT policy_id FROM world_model_retention_audit WHERE policy_id = ?").get(policy.policyId);
    if (existing !== undefined) throw new WorldModelIndexError("retention_policy_reused", "Retention policy has already been applied");

    const rows = this.db.prepare(`SELECT bridge_id, epoch_id, seq, received_at
      FROM world_model_journal WHERE received_at < ? ORDER BY bridge_id, received_at, epoch_id, seq`).all(policy.beforeReceivedAt) as SqlRow[];
    const allByBridge = new Map<string, Array<{ bridgeId: string; epochId: string; seq: number }>>();
    for (const row of this.db.prepare("SELECT bridge_id, epoch_id, seq FROM world_model_journal ORDER BY bridge_id, received_at, epoch_id, seq").all() as SqlRow[]) {
      const id = String(row.bridge_id);
      const list = allByBridge.get(id) ?? [];
      list.push({ bridgeId: id, epochId: String(row.epoch_id), seq: Number(row.seq) });
      allByBridge.set(id, list);
    }
    const keep = new Set<string>();
    for (const list of allByBridge.values()) {
      const retained = this.minimumRawRecords === 0 ? [] : list.slice(-this.minimumRawRecords);
      for (const item of retained) keep.add(rawKey(item.bridgeId, item.epochId, item.seq));
    }
    const affected = rows.filter((row) => !keep.has(rawKey(String(row.bridge_id), String(row.epoch_id), Number(row.seq))));
    const skippedMinimumCount = rows.length - affected.length;
    const appliedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of affected) {
        const key = [String(row.bridge_id), String(row.epoch_id), Number(row.seq)] as const;
        if (policy.mode === "delete") {
          this.db.prepare("DELETE FROM world_model_journal WHERE bridge_id = ? AND epoch_id = ? AND seq = ?").run(...key);
        } else {
          this.db.prepare("UPDATE world_model_journal SET compressed = 1 WHERE bridge_id = ? AND epoch_id = ? AND seq = ?").run(...key);
        }
      }
      const audit: WorldModelRetentionAudit = {
        policyId: policy.policyId,
        mode: policy.mode,
        beforeReceivedAt: policy.beforeReceivedAt,
        requestedBy: policy.requestedBy,
        reason: policy.reason,
        candidateCount: rows.length,
        affectedCount: affected.length,
        deletedCount: policy.mode === "delete" ? affected.length : 0,
        compressedCount: policy.mode === "compress" ? affected.length : 0,
        skippedMinimumCount,
        appliedAt,
      };
      this.db.prepare(`INSERT INTO world_model_retention_audit
        (policy_id, mode, before_received_at, requested_by, reason, candidate_count,
         affected_count, deleted_count, compressed_count, skipped_minimum_count, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        audit.policyId,
        audit.mode,
        audit.beforeReceivedAt,
        audit.requestedBy,
        audit.reason,
        audit.candidateCount,
        audit.affectedCount,
        audit.deletedCount,
        audit.compressedCount,
        audit.skippedMinimumCount,
        audit.appliedAt,
      );
      this.db.exec("COMMIT");
      return audit;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.ensurePrivateFile();
    }
  }

  close(): void {
    this.db.close();
  }

  private ensureDeviceValidityColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(world_model_devices)").all() as SqlRow[];
    if (columns.some((column) => String(column.name) === "validity")) return;
    this.db.exec("ALTER TABLE world_model_devices ADD COLUMN validity TEXT NOT NULL DEFAULT 'valid'");
  }

  private insertJournalRecord(record: IngestRecord): boolean {
    const envelopeJson = JSON.stringify(record.envelope);
    const existing = this.db.prepare(`SELECT envelope_json FROM world_model_journal
      WHERE bridge_id = ? AND epoch_id = ? AND seq = ?`).get(
      record.bridgeId,
      record.envelope.epochId,
      record.envelope.seq,
    ) as SqlRow | undefined;
    if (existing !== undefined) {
      if (String(existing.envelope_json) !== envelopeJson) {
        throw new WorldModelIndexError("invalid_record", "Canonical journal identity was reused with a different envelope");
      }
      return false;
    }
    this.db.prepare(`INSERT INTO world_model_journal
      (bridge_id, epoch_id, seq, received_at, kind, envelope_json, compressed)
      VALUES (?, ?, ?, ?, ?, ?, 0)`).run(
      record.bridgeId,
      record.envelope.epochId,
      record.envelope.seq,
      record.receivedAt,
      record.envelope.event.kind,
      envelopeJson,
    );
    return true;
  }

  private assertReplayIdentity(records: readonly IngestRecord[]): void {
    for (const record of records) {
      const existing = this.db.prepare(`SELECT envelope_json FROM world_model_journal
        WHERE bridge_id = ? AND epoch_id = ? AND seq = ?`).get(
        record.bridgeId,
        record.envelope.epochId,
        record.envelope.seq,
      ) as SqlRow | undefined;
      if (existing !== undefined && String(existing.envelope_json) !== JSON.stringify(record.envelope)) {
        throw new WorldModelIndexError("invalid_record", "Canonical journal identity was reused with a different envelope");
      }
    }
  }

  private upsertDevice(
    record: IngestRecord,
    descriptor: DeviceDescriptor,
    freshness: WorldModelFreshness,
    validity: WorldModelDeviceValidity,
  ): void {
    this.db.prepare(`INSERT INTO world_model_devices
      (bridge_id, native_id, descriptor_json, epoch_id, seq, freshness, validity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bridge_id, native_id) DO UPDATE SET
        descriptor_json = excluded.descriptor_json,
        epoch_id = excluded.epoch_id,
        seq = excluded.seq,
        freshness = excluded.freshness,
        validity = excluded.validity`).run(
      record.bridgeId,
      descriptor.nativeId,
      JSON.stringify(descriptor),
      record.envelope.epochId,
      record.envelope.seq,
      freshness,
      validity,
    );
  }

  private preserveRejectedPresence(
    bridgeId: string,
    nativeIds: readonly string[],
    descriptorIds: ReadonlySet<string>,
    watermark: WorldModelConsistentWatermark,
    freshness: WorldModelFreshness,
  ): void {
    for (const nativeId of nativeIds) {
      const validity: WorldModelDeviceValidity = descriptorIds.has(nativeId)
        ? "invalid-source"
        : "present-but-invalid";
      const existing = this.db.prepare(
        "SELECT native_id FROM world_model_devices WHERE bridge_id = ? AND native_id = ?",
      ).get(bridgeId, nativeId) as SqlRow | undefined;
      if (existing !== undefined) {
        this.db.prepare(`UPDATE world_model_devices
          SET epoch_id = ?, seq = ?, freshness = ?, validity = ?
          WHERE bridge_id = ? AND native_id = ?`).run(
          watermark.epochId,
          watermark.lastSeq,
          freshness,
          validity,
          bridgeId,
          nativeId,
        );
        continue;
      }
      this.db.prepare(`INSERT INTO world_model_devices
        (bridge_id, native_id, descriptor_json, epoch_id, seq, freshness, validity)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        bridgeId,
        nativeId,
        JSON.stringify({ nativeId, capabilities: [] } satisfies DeviceDescriptor),
        watermark.epochId,
        watermark.lastSeq,
        freshness,
        validity,
      );
    }
  }

  private upsertState(record: IngestRecord, state: StateEvent, freshness: WorldModelFreshness): void {
    this.db.prepare(`INSERT INTO world_model_latest_states
      (bridge_id, native_id, native_instance_id, attrs_json, source_ts, source_ts_quality,
       origin, received_at, epoch_id, seq, freshness)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bridge_id, native_id, native_instance_id) DO UPDATE SET
        attrs_json = excluded.attrs_json,
        source_ts = excluded.source_ts,
        source_ts_quality = excluded.source_ts_quality,
        origin = excluded.origin,
        received_at = excluded.received_at,
        epoch_id = excluded.epoch_id,
        seq = excluded.seq,
        freshness = excluded.freshness`).run(
      record.bridgeId,
      state.nativeId,
      state.nativeInstanceId,
      JSON.stringify(state.attrs),
      state.time.sourceTs ?? null,
      state.time.sourceTsQuality,
      state.origin,
      record.receivedAt,
      record.envelope.epochId,
      record.envelope.seq,
      freshness,
    );
  }

  private updateNumericBuckets(record: IngestRecord, state: StateEvent, freshness: WorldModelFreshness): void {
    const bucketStart = bucketStartFor(record.receivedAt, this.bucketMs);
    for (const [attribute, value] of Object.entries(state.attrs)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      this.db.prepare(`INSERT INTO world_model_numeric_buckets
        (bridge_id, native_id, native_instance_id, attribute, bucket_start,
         sample_count, last_value, min_value, max_value, freshness)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(bridge_id, native_id, native_instance_id, attribute, bucket_start)
        DO UPDATE SET
          sample_count = sample_count + 1,
          last_value = excluded.last_value,
          min_value = MIN(min_value, excluded.min_value),
          max_value = MAX(max_value, excluded.max_value),
          freshness = CASE WHEN world_model_numeric_buckets.freshness = 'stale-gap'
            OR excluded.freshness = 'stale-gap' THEN 'stale-gap' ELSE 'fresh' END`).run(
        record.bridgeId,
        state.nativeId,
        state.nativeInstanceId,
        attribute,
        bucketStart,
        value,
        value,
        value,
        freshness,
      );
    }
  }

  private removeDevicesNotInSnapshot(bridgeId: string, descriptorIds: ReadonlySet<string>): void {
    const rows = this.db.prepare("SELECT native_id FROM world_model_devices WHERE bridge_id = ?").all(bridgeId) as SqlRow[];
    for (const row of rows) {
      const nativeId = String(row.native_id);
      if (descriptorIds.has(nativeId)) continue;
      this.db.prepare("DELETE FROM world_model_devices WHERE bridge_id = ? AND native_id = ?").run(bridgeId, nativeId);
      this.db.prepare("DELETE FROM world_model_latest_states WHERE bridge_id = ? AND native_id = ?").run(bridgeId, nativeId);
      this.db.prepare("DELETE FROM world_model_numeric_buckets WHERE bridge_id = ? AND native_id = ?").run(bridgeId, nativeId);
    }
  }

  private insertGap(gap: WorldModelJournalGap, recordedAt: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO world_model_gaps
      (bridge_id, epoch_id, from_seq, to_seq, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      gap.bridgeId,
      gap.epochId,
      gap.fromSeq,
      gap.toSeq,
      gap.reason,
      recordedAt,
    );
  }

  private watermarkRow(bridgeId: string): { epochId: string; lastSeq: number; freshness: WorldModelFreshness } | undefined {
    const row = this.db.prepare("SELECT epoch_id, last_seq, freshness FROM world_model_watermarks WHERE bridge_id = ?").get(bridgeId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return { epochId: String(row.epoch_id), lastSeq: Number(row.last_seq), freshness: String(row.freshness) as WorldModelFreshness };
  }

  private ensurePrivateFile(path = this.path): void {
    ensurePrivateSqliteFiles(path);
  }
}

function prepareBatch(batch: WorldModelConsistentBatch): {
  bridgeId: string;
  records: IngestRecord[];
  watermark: WorldModelConsistentWatermark;
  gaps: WorldModelJournalGap[];
  rejectedNativeIds: string[];
} {
  if (!batch || typeof batch !== "object" || !nonEmptyString(batch.bridgeId) || !Array.isArray(batch.records)) {
    throw new WorldModelIndexError("invalid_batch", "A world model batch requires a bridgeId and records");
  }
  const watermark = batch.consistentWatermark;
  if (!watermark || !nonEmptyString(watermark.epochId) || !positiveSafeInteger(watermark.lastSeq, "lastSeq")) {
    throw new WorldModelIndexError("invalid_batch", "A world model batch requires a valid consistent watermark");
  }
  const records = batch.records.map((candidate) => {
    const parsed = ingestRecordSchema.safeParse(candidate);
    if (!parsed.success) throw new WorldModelIndexError("invalid_record", "World model input is not a canonical journal record");
    if (parsed.data.bridgeId !== batch.bridgeId) {
      throw new WorldModelIndexError("invalid_record", "All journal records in a batch must belong to one bridge");
    }
    if (containsNativePayload(parsed.data)) {
      throw new WorldModelIndexError("native_payload_rejected", "Native ecosystem payloads cannot enter the world model index");
    }
    if (!Number.isFinite(Date.parse(parsed.data.receivedAt))) {
      throw new WorldModelIndexError("invalid_record", "Journal receivedAt must be a parseable timestamp");
    }
    return parsed.data;
  });
  const gaps = (batch.gaps ?? []).map((gap) => {
    if (!gap || gap.bridgeId !== batch.bridgeId || !nonEmptyString(gap.epochId)
      || !positiveSafeInteger(gap.fromSeq, "fromSeq") || !positiveSafeInteger(gap.toSeq, "toSeq")
      || gap.fromSeq > gap.toSeq || !nonEmptyString(gap.reason)) {
      throw new WorldModelIndexError("invalid_batch", "World model history gap is invalid");
    }
    return { ...gap };
  });
  const rejectedNativeIds = [...new Set(batch.rejectedNativeIds ?? [])];
  if (rejectedNativeIds.some((nativeId) => !nonEmptyString(nativeId))) {
    throw new WorldModelIndexError("invalid_batch", "Rejected presence native IDs must be non-empty strings");
  }
  const target = records
    .filter((item) => item.envelope.epochId === watermark.epochId && item.envelope.seq <= watermark.lastSeq)
    .sort((left, right) => left.envelope.seq - right.envelope.seq);
  const seen = new Set<number>();
  for (const item of target) {
    if (seen.has(item.envelope.seq)) throw new WorldModelIndexError("inconsistent_snapshot", "Consistent journal contains duplicate sequence numbers");
    seen.add(item.envelope.seq);
  }
  const starts = target.filter((item) => item.envelope.event.kind === "sync-start");
  const completes = target.filter((item) => item.envelope.event.kind === "sync-complete");
  if (starts.length !== 1 || completes.length !== 1) {
    throw new WorldModelIndexError("inconsistent_snapshot", "A consistent journal requires exactly one sync-start and sync-complete");
  }
  const start = starts[0];
  const complete = target.find((item) => item.envelope.seq === watermark.lastSeq);
  if (start === undefined || start.envelope.seq !== 1 || start.envelope.event.kind !== "sync-start"
    || complete === undefined || complete.envelope.event.kind !== "sync-complete") {
    throw new WorldModelIndexError("inconsistent_snapshot", "Consistent watermark must point at sync-start/sync-complete");
  }
  if (start.envelope.event.kind !== "sync-start" || complete.envelope.event.kind !== "sync-complete"
    || start.envelope.event.snapshotId !== complete.envelope.event.manifest.snapshotId) {
    throw new WorldModelIndexError("inconsistent_snapshot", "Sync manifest does not match sync-start");
  }
  let deviceCount = 0;
  let stateCount = 0;
  for (const item of target) {
    if (item.envelope.event.kind === "device-upserted") deviceCount += 1;
    if (item.envelope.event.kind === "state") stateCount += 1;
    if (item.envelope.event.kind === "device-removed") {
      throw new WorldModelIndexError("inconsistent_snapshot", "device-removed is not legal in a consistent replay");
    }
  }
  const manifest = complete.envelope.event.manifest;
  const manifestCountsMatch = batch.allowRejectedEvents
    ? manifest.deviceEnvelopeCount >= deviceCount && manifest.stateEnvelopeCount >= stateCount
    : manifest.deviceEnvelopeCount === deviceCount && manifest.stateEnvelopeCount === stateCount;
  if (!manifestCountsMatch) {
    throw new WorldModelIndexError("inconsistent_snapshot", "Sync manifest counts do not match canonical journal records");
  }
  return {
    bridgeId: batch.bridgeId,
    records: target,
    watermark: { ...watermark },
    gaps,
    rejectedNativeIds,
  };
}

function containsNativePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNativePayload);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (NATIVE_PAYLOAD_KEYS.has(key)) return true;
    if (containsNativePayload(nested)) return true;
  }
  return false;
}

function batchFreshness(
  bridgeId: string,
  watermark: WorldModelConsistentWatermark,
  gaps: readonly WorldModelJournalGap[],
): WorldModelFreshness {
  return gaps.some((gap) => gap.bridgeId === bridgeId
    && (gap.epochId !== watermark.epochId || gap.fromSeq <= watermark.lastSeq))
    ? "stale-gap"
    : "fresh";
}

function eventFreshness(
  record: IngestRecord,
  gaps: readonly WorldModelJournalGap[],
  watermark: WorldModelConsistentWatermark,
): WorldModelFreshness {
  const priorEpochGap = gaps.some((gap) => gap.epochId !== watermark.epochId);
  const currentEpochGap = gaps.some((gap) => gap.epochId === record.envelope.epochId && gap.fromSeq <= record.envelope.seq);
  return priorEpochGap || currentEpochGap
    ? "stale-gap"
    : "fresh";
}

function bucketStartFor(receivedAt: string, bucketMs: number): string {
  const timestamp = Date.parse(receivedAt);
  return new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString();
}

function whereQuery(
  table: "world_model_latest_states" | "world_model_numeric_buckets",
  query: WorldModelStateQuery | WorldModelAggregateQuery,
): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [field, value] of [
    ["bridge_id", query.bridgeId],
    ["native_id", query.nativeId],
    ["native_instance_id", query.nativeInstanceId],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${table}.${field} = ?`);
      params.push(value);
    }
  }
  if (table === "world_model_numeric_buckets") {
    const aggregateQuery = query as WorldModelAggregateQuery;
    if (aggregateQuery.attribute !== undefined) {
      clauses.push(`${table}.attribute = ?`);
      params.push(aggregateQuery.attribute);
    }
    if (aggregateQuery.bucketStart !== undefined) {
      clauses.push(`${table}.bucket_start = ?`);
      params.push(aggregateQuery.bucketStart);
    }
  }
  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
}

function rowToLatestState(row: SqlRow): WorldModelLatestState {
  return {
    bridgeId: String(row.bridge_id),
    nativeId: String(row.native_id),
    nativeInstanceId: String(row.native_instance_id),
    attrs: JSON.parse(String(row.attrs_json)) as Record<string, JsonValue>,
    ...(row.source_ts === null || row.source_ts === undefined ? {} : { sourceTs: String(row.source_ts) }),
    sourceTsQuality: String(row.source_ts_quality) as StateEvent["time"]["sourceTsQuality"],
    origin: String(row.origin) as StateEvent["origin"],
    receivedAt: String(row.received_at),
    epochId: String(row.epoch_id),
    seq: Number(row.seq),
    freshness: String(row.freshness) as WorldModelFreshness,
  };
}

function validateRetentionPolicy(policy: WorldModelRetentionPolicy): void {
  if (!policy || typeof policy !== "object" || !nonEmptyString(policy.policyId)
    || (policy.mode !== "delete" && policy.mode !== "compress")
    || !nonEmptyString(policy.beforeReceivedAt) || !Number.isFinite(Date.parse(policy.beforeReceivedAt))
    || !nonEmptyString(policy.requestedBy) || !nonEmptyString(policy.reason)) {
    throw new WorldModelIndexError("retention_policy_invalid", "Retention requires an explicit bounded policy and audit reason");
  }
}

function rawKey(bridgeId: string, epochId: string, seq: number): string {
  return `${bridgeId}\u0000${epochId}\u0000${seq}`;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new WorldModelIndexError("invalid_batch", `${name} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
