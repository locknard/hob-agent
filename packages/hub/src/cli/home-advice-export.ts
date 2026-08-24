import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  parseHomeAdviceReport,
  type HomeAdviceReport,
} from "@hob-agent/agent-layer/home-advice-report";

import type { LaunchEnvironment } from "../launch-config.js";
import type { HomeAdviceProgressType } from "../home/home-advice-store.js";

export const HOME_ADVICE_EXPORT_EXIT_CODES = Object.freeze({
  evidence: 0,
  insufficientEvidence: 2,
  invalidArguments: 1,
} as const);

export type HomeAdviceExportReason =
  | "advice_store_unavailable"
  | "advice_store_corrupt"
  | "advice_not_found"
  | "causality_stage_missing"
  | "advice_not_completed";

export type HomeAdviceManifestReport = {
  readonly schemaVersion: "1";
  readonly outcome: "evidence" | "insufficient_evidence";
  readonly adviceId: string;
  readonly status: "running" | "background" | "completed" | "failed";
  readonly createdAt: string;
  readonly backgroundAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly stages: readonly {
    readonly stage: HomeAdviceProgressType;
    readonly at: string;
  }[];
  readonly causality: "observed" | "unknown";
  readonly reason?: Exclude<HomeAdviceExportReason, "advice_store_unavailable" | "advice_store_corrupt" | "advice_not_found">;
  readonly report: HomeAdviceReportAggregate;
  readonly readMode: "durable_only";
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
};

export interface HomeAdviceReportAggregate {
  readonly present: boolean;
  readonly confidence?: HomeAdviceReport["confidence"];
  readonly findings?: number;
  readonly unknowns?: number;
  readonly trial?: boolean;
  readonly hardwareSuggestions?: number;
  readonly validationSteps?: number;
}

export interface HomeAdviceManifestFailure {
  readonly schemaVersion: "1";
  readonly outcome: "insufficient_evidence";
  readonly adviceId: string;
  readonly reason: Exclude<HomeAdviceExportReason, "causality_stage_missing" | "advice_not_completed">;
  readonly readMode: "durable_only";
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
}

export type HomeAdviceAcceptanceManifest = HomeAdviceManifestReport | HomeAdviceManifestFailure;
export type HomeAdviceExportEnvironment = LaunchEnvironment;

/** Parses one explicit advice id; the exporter never selects a hidden latest turn. */
export function parseHomeAdviceExportArgs(
  args: readonly string[],
): { readonly adviceId: string } {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0 || normalized[0] !== "--advice-id") {
    throw new TypeError("--advice-id is required");
  }
  if (normalized.length < 2) throw new TypeError("--advice-id is required");
  if (normalized.length > 2) throw new TypeError("unknown argument");
  const adviceId = normalized[1];
  if (!isBoundedId(adviceId)) throw new TypeError("invalid advice id");
  return { adviceId };
}

/** Reads one existing advice database through the durable, read-only path. */
export function readHomeAdviceAcceptanceManifest(
  environment: HomeAdviceExportEnvironment,
  adviceId: string,
): HomeAdviceAcceptanceManifest {
  const dataDirectory = environment.HOB_DATA_DIR;
  const advicePath = typeof dataDirectory === "string" && dataDirectory.trim() !== ""
    ? join(dataDirectory, "home-advice.sqlite")
    : "";
  return readHomeAdviceAcceptanceManifestFromPath(advicePath, adviceId);
}

/** Reads without schema setup, expiry, writes, runtime startup, or credential access. */
export function readHomeAdviceAcceptanceManifestFromPath(
  advicePath: string,
  adviceId: string,
): HomeAdviceAcceptanceManifest {
  if (!isBoundedId(adviceId)) throw new TypeError("invalid advice id");
  if (!isPath(advicePath)) return unavailable(adviceId);
  return readDurableStore(advicePath, adviceId);
}

interface AdviceRow {
  readonly adviceId: string;
  readonly status: HomeAdviceManifestReport["status"];
  readonly createdAt: string;
  readonly backgroundAt?: string;
  readonly completedAt?: string;
  readonly report?: HomeAdviceReport;
}

interface AdviceStage {
  readonly stage: HomeAdviceProgressType;
  readonly at: string;
}

interface Row {
  readonly [key: string]: unknown;
}

interface DurableFileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type ReadResult =
  | { readonly kind: "ok"; readonly value: HomeAdviceAcceptanceManifest }
  | { readonly kind: "failure"; readonly reason: Exclude<HomeAdviceExportReason, "causality_stage_missing" | "advice_not_completed"> };

function readDurableStore(path: string, adviceId: string): HomeAdviceAcceptanceManifest {
  const beforeOpen = readRegularFileMetadata(path);
  if (beforeOpen === undefined) return unavailable(adviceId);

  let db: DatabaseSync | undefined;
  let transactionStarted = false;
  let dataVersionBefore: bigint | undefined;
  let result: ReadResult = { kind: "failure", reason: "advice_store_unavailable" };
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!sameDurableFileMetadata(beforeOpen, readRegularFileMetadata(path))) return unavailable(adviceId);
    dataVersionBefore = readDataVersion(db);
    db.exec("BEGIN DEFERRED");
    transactionStarted = true;
    result = readAdvice(db, adviceId);
  } catch (error) {
    result = {
      kind: "failure",
      reason: isUnavailableStoreError(error) ? "advice_store_unavailable" : "advice_store_corrupt",
    };
  } finally {
    if (transactionStarted) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        result = { kind: "failure", reason: "advice_store_unavailable" };
      }
    }
    if (dataVersionBefore !== undefined && db !== undefined) {
      try {
        if (readDataVersion(db) !== dataVersionBefore) {
          result = { kind: "failure", reason: "advice_store_unavailable" };
        }
      } catch {
        result = { kind: "failure", reason: "advice_store_unavailable" };
      }
    }
    if (!sameDurableFileMetadata(beforeOpen, readRegularFileMetadata(path))) {
      result = { kind: "failure", reason: "advice_store_unavailable" };
    }
    try {
      db?.close();
    } catch {
      result = { kind: "failure", reason: "advice_store_unavailable" };
    }
  }
  return result.kind === "ok" ? result.value : failure(adviceId, result.reason);
}

function readAdvice(db: DatabaseSync, adviceId: string): ReadResult {
  const row = db.prepare(`SELECT advice_id, question, status, report_json, created_at, background_at, completed_at
    FROM home_advice WHERE advice_id = ?`).get(adviceId) as Row | undefined;
  if (row === undefined) return { kind: "failure", reason: "advice_not_found" };
  const advice = parseAdviceRow(row);
  if (advice === undefined) return { kind: "failure", reason: "advice_store_corrupt" };

  const rows = db.prepare(`SELECT event_id, stage, event_at
    FROM home_advice_events WHERE advice_id = ? ORDER BY event_id ASC`).all(adviceId) as Row[];
  const stages = parseStages(rows, advice);
  if (stages === undefined) return { kind: "failure", reason: "advice_store_corrupt" };
  return { kind: "ok", value: projectManifest(advice, stages) };
}

function parseAdviceRow(row: Row): AdviceRow | undefined {
  const adviceId = row.advice_id;
  const question = row.question;
  const status = row.status;
  const createdAt = row.created_at;
  const backgroundAt = row.background_at;
  const completedAt = row.completed_at;
  if (!isBoundedId(adviceId)
    || typeof question !== "string"
    || question.trim() !== question
    || question.length < 1
    || question.length > 1_000
    || !isIsoTimestamp(createdAt)
    || (backgroundAt !== null && !isIsoTimestamp(backgroundAt))
    || (completedAt !== null && !isIsoTimestamp(completedAt))) return undefined;
  if (status !== "running" && status !== "background" && status !== "completed" && status !== "failed") return undefined;
  if (status === "running" && (row.report_json !== null || backgroundAt !== null || completedAt !== null)) return undefined;
  if (status === "background" && (row.report_json !== null || backgroundAt === null || completedAt !== null)) return undefined;
  if (status === "failed" && (row.report_json !== null || completedAt === null)) return undefined;
  if (status === "completed" && (typeof row.report_json !== "string" || completedAt === null)) return undefined;
  const report = status === "completed" ? parseReport(row.report_json) : undefined;
  if (status === "completed" && report === undefined) return undefined;
  return {
    adviceId,
    status,
    createdAt,
    ...(backgroundAt === null ? {} : { backgroundAt }),
    ...(completedAt === null ? {} : { completedAt }),
    ...(report === undefined ? {} : { report }),
  };
}

function parseReport(value: unknown): HomeAdviceReport | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseHomeAdviceReport(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseStages(rows: readonly Row[], advice: AdviceRow): readonly AdviceStage[] | undefined {
  let previousId = 0;
  const stages: AdviceStage[] = [];
  for (const row of rows) {
    const id = row.event_id;
    const stage = row.stage;
    const at = row.event_at;
    if (typeof id !== "number"
      || !Number.isSafeInteger(id)
      || id < 1
      || id <= previousId
      || !isHomeAdviceProgressType(stage)
      || !isIsoTimestamp(at)
      || Date.parse(at) < Date.parse(advice.createdAt)
      || (advice.completedAt !== undefined && Date.parse(at) > Date.parse(advice.completedAt))) return undefined;
    previousId = id;
    stages.push({ stage, at });
  }
  const last = stages.at(-1)?.stage;
  if ((advice.status === "completed" && last !== "completed")
    || (advice.status === "failed" && last !== "failed" && last !== "cancelled")) return undefined;
  return stages;
}

function projectManifest(advice: AdviceRow, stages: readonly AdviceStage[]): HomeAdviceManifestReport {
  const causalityObserved = stages.some((event) => event.stage === "causality");
  const report = advice.report === undefined
    ? { present: false }
    : {
      present: true,
      confidence: advice.report.confidence,
      findings: advice.report.findings.length,
      unknowns: advice.report.unknowns.length,
      trial: advice.report.trial !== undefined,
      hardwareSuggestions: advice.report.hardwareSuggestions.length,
      validationSteps: advice.report.validationSteps.length,
    };
  const completeWithCausality = advice.status === "completed" && causalityObserved;
  return {
    schemaVersion: "1",
    outcome: completeWithCausality ? "evidence" : "insufficient_evidence",
    adviceId: advice.adviceId,
    status: advice.status,
    createdAt: advice.createdAt,
    ...(advice.backgroundAt === undefined ? {} : { backgroundAt: advice.backgroundAt }),
    ...(advice.completedAt === undefined ? {} : { completedAt: advice.completedAt }),
    ...(advice.completedAt === undefined ? {} : { durationMs: Date.parse(advice.completedAt) - Date.parse(advice.createdAt) }),
    stages,
    causality: causalityObserved ? "observed" : "unknown",
    ...(causalityObserved ? (advice.status === "completed" ? {} : { reason: "advice_not_completed" as const }) : { reason: "causality_stage_missing" as const }),
    report,
    readMode: "durable_only",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

function unavailable(adviceId: string): HomeAdviceManifestFailure {
  return failure(adviceId, "advice_store_unavailable");
}

function failure(
  adviceId: string,
  reason: HomeAdviceManifestFailure["reason"],
): HomeAdviceManifestFailure {
  return {
    schemaVersion: "1",
    outcome: "insufficient_evidence",
    adviceId,
    reason,
    readMode: "durable_only",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  };
}

function isHomeAdviceProgressType(value: unknown): value is HomeAdviceProgressType {
  return value === "accepted"
    || value === "inspecting_home"
    || value === "reading_inventory"
    || value === "checking_rules"
    || value === "evaluating_evidence"
    || value === "causality"
    || value === "composing_answer"
    || value === "background"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 200;
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && value !== ":memory:";
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.includes("T");
}

function readRegularFileMetadata(path: string): DurableFileMetadata | undefined {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isFile()) return undefined;
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
    };
  } catch {
    return undefined;
  }
}

function sameDurableFileMetadata(
  before: DurableFileMetadata | undefined,
  after: DurableFileMetadata | undefined,
): boolean {
  return before !== undefined && after !== undefined
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function readDataVersion(db: DatabaseSync): bigint {
  const statement = db.prepare("PRAGMA data_version");
  statement.setReadBigInts(true);
  const row = statement.get() as Row | undefined;
  if (typeof row?.data_version !== "bigint" || row.data_version < 0n) {
    throw new Error("SQLite data_version is invalid");
  }
  return row.data_version;
}

function isUnavailableStoreError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT"
    || code === "EACCES"
    || code === "EBUSY"
    || code === "ETXTBSY"
    || code === "SQLITE_BUSY"
    || code === "SQLITE_READONLY";
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  try {
    const { adviceId } = parseHomeAdviceExportArgs(process.argv.slice(2));
    const result = readHomeAdviceAcceptanceManifest(process.env, adviceId);
    console.log(JSON.stringify(result));
    if (result.outcome === "insufficient_evidence") process.exitCode = HOME_ADVICE_EXPORT_EXIT_CODES.insufficientEvidence;
  } catch {
    console.error("hob-agent home advice export requires one valid --advice-id");
    process.exitCode = HOME_ADVICE_EXPORT_EXIT_CODES.invalidArguments;
  }
}
