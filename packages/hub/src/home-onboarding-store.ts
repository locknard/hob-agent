import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "./sqlite-private-files.js";

export const HOME_ONBOARDING_STATE_VERSION = 1 as const;
export const HOME_ONBOARDING_STEP_COUNT = 8 as const;

export type HomeOnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type HomeOnboardingStepStatus = "pending" | "completed" | "blocked";

export interface HomeOnboardingStepRecord {
  readonly status: HomeOnboardingStepStatus;
  readonly updatedAt: string;
  readonly summary: string;
  readonly blockedReason?: string;
}

export interface HomeOnboardingHousehold {
  readonly householdName: string;
  readonly agentName: string;
}

export interface HomeOnboardingBridgeResult {
  readonly bridgeId: string;
  readonly status: "ready";
  readonly checkedAt: string;
}

export interface HomeOnboardingMapResult {
  readonly snapshotDigest: string;
  readonly confirmedAt: string;
  readonly correction?: string;
}

export interface HomeOnboardingMemberResult {
  readonly principalId: string;
  readonly memberName: string;
  readonly role: "adult_admin";
  readonly deviceKind: "private";
  readonly boundAt: string;
}

export interface HomeOnboardingSafetyResult {
  readonly acknowledgedAt: string;
}

export interface HomeOnboardingObservationResult {
  readonly enabled: boolean;
  readonly intervalMinutes?: number;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly configuredAt: string;
}

export interface HomeOnboardingFirstQuestionResult {
  readonly question: string;
  readonly adviceId: string;
  readonly acceptedAt: string;
}

export interface HomeOnboardingState {
  readonly version: typeof HOME_ONBOARDING_STATE_VERSION;
  readonly currentStep: HomeOnboardingStep;
  readonly completedSteps: readonly HomeOnboardingStep[];
  readonly complete: boolean;
  readonly updatedAt: string;
  readonly steps: Readonly<Record<HomeOnboardingStep, HomeOnboardingStepRecord>>;
  readonly household?: HomeOnboardingHousehold;
  readonly bridge?: HomeOnboardingBridgeResult;
  readonly map?: HomeOnboardingMapResult;
  readonly member?: HomeOnboardingMemberResult;
  readonly safety?: HomeOnboardingSafetyResult;
  readonly observation?: HomeOnboardingObservationResult;
  readonly firstQuestion?: HomeOnboardingFirstQuestionResult;
}

export interface HomeOnboardingStore {
  load(): HomeOnboardingState | undefined;
  save(state: HomeOnboardingState): void;
  close?(): void;
}

export interface FileHomeOnboardingStoreOptions {
  readonly path: string;
}

export class HomeOnboardingStoreError extends Error {
  constructor(readonly code: "invalid" | "corrupt" | "io", message: string) {
    super(message);
    this.name = "HomeOnboardingStoreError";
  }
}

/** Durable, private Hub-owned onboarding state. */
export class FileHomeOnboardingStore implements HomeOnboardingStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: FileHomeOnboardingStoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.trim() === "") {
      throw new TypeError("Home onboarding store path is required");
    }
    this.path = options.path;
    if (!isMemoryPath(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.path);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS home_onboarding_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL
        ) STRICT;
      `);
      ensurePrivateSqliteFiles(this.path);
    } catch {
      throw new HomeOnboardingStoreError("io", "Unable to open home onboarding store");
    }
  }

  load(): HomeOnboardingState | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT state_json FROM home_onboarding_state WHERE singleton = 1").get() as
      | { state_json?: unknown }
      | undefined;
    if (row === undefined) return undefined;
    try {
      if (typeof row.state_json !== "string") throw new Error("state is not text");
      return parseHomeOnboardingState(JSON.parse(row.state_json));
    } catch (error) {
      if (error instanceof HomeOnboardingStoreError) throw error;
      throw new HomeOnboardingStoreError("corrupt", "Stored home onboarding state is invalid");
    }
  }

  save(state: HomeOnboardingState): void {
    this.assertOpen();
    const parsed = parseHomeOnboardingState(state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO home_onboarding_state (singleton, state_json)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`).run(JSON.stringify(parsed));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the write error */ }
      throw new HomeOnboardingStoreError("io", error instanceof Error ? error.message : "Unable to save home onboarding state");
    } finally {
      ensurePrivateSqliteFiles(this.path);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new HomeOnboardingStoreError("io", "Home onboarding store is closed");
  }
}

/** Explicit deterministic seam for tests and embedders. Production supplies a file store. */
export class InMemoryHomeOnboardingStore implements HomeOnboardingStore {
  private state: HomeOnboardingState | undefined;

  constructor(initial?: HomeOnboardingState) {
    this.state = initial === undefined ? undefined : parseHomeOnboardingState(initial);
  }

  load(): HomeOnboardingState | undefined {
    return this.state === undefined ? undefined : cloneState(this.state);
  }

  save(state: HomeOnboardingState): void {
    this.state = cloneState(parseHomeOnboardingState(state));
  }
}

export function initialHomeOnboardingState(updatedAt: string): HomeOnboardingState {
  assertIsoTimestamp(updatedAt);
  const steps = {} as Record<HomeOnboardingStep, HomeOnboardingStepRecord>;
  for (const step of allSteps()) {
    steps[step] = { status: "pending", updatedAt, summary: "尚未完成" };
  }
  return {
    version: HOME_ONBOARDING_STATE_VERSION,
    currentStep: 1,
    completedSteps: [],
    complete: false,
    updatedAt,
    steps,
  };
}

export function parseHomeOnboardingState(value: unknown): HomeOnboardingState {
  if (!isRecord(value) || value.version !== HOME_ONBOARDING_STATE_VERSION
    || !isStep(value.currentStep)
    || !Array.isArray(value.completedSteps)
    || !value.completedSteps.every(isStep)
    || typeof value.complete !== "boolean"
    || typeof value.updatedAt !== "string"
    || !isIsoTimestamp(value.updatedAt)
    || !isRecord(value.steps)) throw invalidState();

  const completedSteps = [...value.completedSteps] as HomeOnboardingStep[];
  if (new Set(completedSteps).size !== completedSteps.length
    || completedSteps.some((step, index) => step !== index + 1)
    || (!value.complete && completedSteps.length !== value.currentStep - 1)
    || (value.complete && (value.currentStep !== HOME_ONBOARDING_STEP_COUNT || completedSteps.length !== HOME_ONBOARDING_STEP_COUNT))) {
    throw invalidState();
  }

  const steps = parseStepRecords(value.steps);
  for (const step of allSteps()) {
    const record = steps[step]!;
    const expected = completedSteps.includes(step) ? "completed"
      : step === value.currentStep && record.status === "blocked" ? "blocked"
        : "pending";
    if (record.status !== expected) throw invalidState();
  }

  const state: HomeOnboardingState = {
    version: HOME_ONBOARDING_STATE_VERSION,
    currentStep: value.currentStep,
    completedSteps,
    complete: value.complete,
    updatedAt: value.updatedAt,
    steps,
    ...(value.household === undefined ? {} : { household: parseHousehold(value.household) }),
    ...(value.bridge === undefined ? {} : { bridge: parseBridge(value.bridge) }),
    ...(value.map === undefined ? {} : { map: parseMap(value.map) }),
    ...(value.member === undefined ? {} : { member: parseMember(value.member) }),
    ...(value.safety === undefined ? {} : { safety: parseSafety(value.safety) }),
    ...(value.observation === undefined ? {} : { observation: parseObservation(value.observation) }),
    ...(value.firstQuestion === undefined ? {} : { firstQuestion: parseFirstQuestion(value.firstQuestion) }),
  };
  if (Object.keys(value).some((key) => !KNOWN_STATE_KEYS.has(key))) throw invalidState();
  return cloneState(state);
}

function parseStepRecords(value: Record<string, unknown>): Record<HomeOnboardingStep, HomeOnboardingStepRecord> {
  const keys = Object.keys(value);
  if (keys.length !== HOME_ONBOARDING_STEP_COUNT || keys.some((key) => !/^[1-8]$/.test(key))) throw invalidState();
  const steps = {} as Record<HomeOnboardingStep, HomeOnboardingStepRecord>;
  for (const step of allSteps()) {
    const raw = value[String(step)];
    if (!isRecord(raw) || !isStepStatus(raw.status) || typeof raw.updatedAt !== "string" || !isIsoTimestamp(raw.updatedAt)
      || !boundedText(raw.summary, 2_000)
      || (raw.blockedReason !== undefined && !boundedText(raw.blockedReason, 2_000))) throw invalidState();
    if (raw.status !== "blocked" && raw.blockedReason !== undefined) throw invalidState();
    steps[step] = {
      status: raw.status,
      updatedAt: raw.updatedAt,
      summary: raw.summary,
      ...(raw.blockedReason === undefined ? {} : { blockedReason: raw.blockedReason }),
    };
  }
  return steps;
}

function parseHousehold(value: unknown): HomeOnboardingHousehold {
  if (!isRecord(value) || !boundedText(value.householdName, 200) || !boundedText(value.agentName, 200)) throw invalidState();
  return { householdName: value.householdName, agentName: value.agentName };
}

function parseBridge(value: unknown): HomeOnboardingBridgeResult {
  if (!isRecord(value) || !boundedId(value.bridgeId) || value.status !== "ready" || typeof value.checkedAt !== "string" || !isIsoTimestamp(value.checkedAt)) throw invalidState();
  return { bridgeId: value.bridgeId, status: "ready", checkedAt: value.checkedAt };
}

function parseMap(value: unknown): HomeOnboardingMapResult {
  if (!isRecord(value) || !/^sha256:[a-f0-9]{64}$/.test(String(value.snapshotDigest)) || typeof value.confirmedAt !== "string" || !isIsoTimestamp(value.confirmedAt) || (value.correction !== undefined && !boundedText(value.correction, 2_000))) throw invalidState();
  return { snapshotDigest: value.snapshotDigest as string, confirmedAt: value.confirmedAt, ...(value.correction === undefined ? {} : { correction: value.correction }) };
}

function parseMember(value: unknown): HomeOnboardingMemberResult {
  if (!isRecord(value) || !boundedId(value.principalId) || !boundedText(value.memberName, 200) || value.role !== "adult_admin" || value.deviceKind !== "private" || typeof value.boundAt !== "string" || !isIsoTimestamp(value.boundAt)) throw invalidState();
  return { principalId: value.principalId, memberName: value.memberName, role: "adult_admin", deviceKind: "private", boundAt: value.boundAt };
}

function parseSafety(value: unknown): HomeOnboardingSafetyResult {
  if (!isRecord(value) || typeof value.acknowledgedAt !== "string" || !isIsoTimestamp(value.acknowledgedAt)) throw invalidState();
  return { acknowledgedAt: value.acknowledgedAt };
}

function parseObservation(value: unknown): HomeOnboardingObservationResult {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.configuredAt !== "string" || !isIsoTimestamp(value.configuredAt)) throw invalidState();
  if (value.intervalMinutes !== undefined && (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 60 || value.intervalMinutes > 10_080)) throw invalidState();
  if (value.enabled && value.intervalMinutes === undefined) throw invalidState();
  if (value.quietHours !== undefined) {
    if (!isRecord(value.quietHours) || !validClockTime(value.quietHours.start) || !validClockTime(value.quietHours.end)) throw invalidState();
  }
  return { enabled: value.enabled, ...(value.intervalMinutes === undefined ? {} : { intervalMinutes: value.intervalMinutes }), ...(value.quietHours === undefined ? {} : { quietHours: { start: value.quietHours.start, end: value.quietHours.end } }), configuredAt: value.configuredAt };
}

function parseFirstQuestion(value: unknown): HomeOnboardingFirstQuestionResult {
  if (!isRecord(value)
    || !boundedText(value.question, 2_000)
    || !boundedId(value.adviceId)
    || typeof value.acceptedAt !== "string"
    || !isIsoTimestamp(value.acceptedAt)) throw invalidState();
  return { question: value.question, adviceId: value.adviceId, acceptedAt: value.acceptedAt };
}

function cloneState(state: HomeOnboardingState): HomeOnboardingState {
  return JSON.parse(JSON.stringify(state)) as HomeOnboardingState;
}

function allSteps(): readonly HomeOnboardingStep[] { return [1, 2, 3, 4, 5, 6, 7, 8]; }
function isStep(value: unknown): value is HomeOnboardingStep { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 8; }
function isStepStatus(value: unknown): value is HomeOnboardingStepStatus { return value === "pending" || value === "completed" || value === "blocked"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max; }
function boundedId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function validClockTime(value: unknown): value is string { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function assertIsoTimestamp(value: string): void { if (!isIsoTimestamp(value)) throw new TypeError("Home onboarding timestamp is invalid"); }
function isIsoTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isMemoryPath(path: string): boolean { return path === ":memory:" || path.startsWith("file::memory:"); }
function invalidState(): HomeOnboardingStoreError { return new HomeOnboardingStoreError("corrupt", "Home onboarding state is invalid"); }

const KNOWN_STATE_KEYS = new Set([
  "version", "currentStep", "completedSteps", "complete", "updatedAt", "steps", "household", "bridge", "map", "member", "safety", "observation", "firstQuestion",
]);
