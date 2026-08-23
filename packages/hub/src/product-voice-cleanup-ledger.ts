import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const LEDGER_VERSION = "hob.product-voice-cleanup/v1" as const;
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 16_384;
const LOCK_STALE_AFTER_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const VOICE_REF = /^keychain:hob-agent\/voice:(asr|tts):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEASE_AUTHORITY = Symbol("product-voice-cleanup-ledger");

export type ProductVoiceCleanupTrack = "asr" | "tts";
export type ProductVoiceCleanupPhase = "staged" | "active" | "pending_cleanup";
export type ProductVoiceCleanupReason = "vault_write_pending" | "configuration_committed" | "candidate_abandoned" | "retired";

/** Metadata-only ownership record for one exact private voice credential locator. */
export interface ProductVoiceCleanupEntry {
  readonly candidateId: string;
  readonly track: ProductVoiceCleanupTrack;
  readonly credentialRef: string;
  readonly phase: ProductVoiceCleanupPhase;
  readonly reason: ProductVoiceCleanupReason;
  readonly expectedGeneration: number;
  readonly committedGeneration?: number;
  readonly createdAt: string;
  readonly attempts: number;
}

export interface ProductVoiceCleanupLedgerState {
  readonly version: typeof LEDGER_VERSION;
  readonly entries: readonly ProductVoiceCleanupEntry[];
}

/** An unforgeable, single-use authorization for one durably reserved voice locator. */
export class ProductVoiceCredentialLease {
  #consumed = false;

  constructor(
    private readonly track: ProductVoiceCleanupTrack,
    private readonly credentialRef: string,
    authority: symbol,
  ) {
    if (authority !== LEASE_AUTHORITY) throw new TypeError("Voice credential lease is invalid");
  }

  consume(stage: { readonly kind: ProductVoiceCleanupTrack; readonly credentialRef?: string }): void {
    if (this.#consumed || stage.kind !== this.track || stage.credentialRef !== this.credentialRef) {
      throw new TypeError("Voice credential lease is invalid");
    }
    this.#consumed = true;
  }
}

export class ProductVoiceCleanupLedger {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(directory, "product-voice-cleanup-ledger.json");
    this.lockPath = join(directory, "product-voice-cleanup-ledger.lock");
  }

  /** Loads all durable ownership records so a restarted service can recover staged and active entries. */
  async load(): Promise<ProductVoiceCleanupLedgerState> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyLedger();
      throw error;
    }
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw invalidLedger();
    try {
      return validateLedger(JSON.parse(source) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw invalidLedger();
      throw error;
    }
  }

  /** Reserves an exact locator before the vault can receive its credential value. */
  async reserve(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
    readonly expectedGeneration: number;
  }): Promise<ProductVoiceCredentialLease> {
    const reference = validateReferenceInput(input);
    await this.mutate(async (state) => {
      if (state.entries.some((entry) => entry.credentialRef === reference.credentialRef)) {
        throw new Error("Voice cleanup ledger reference is duplicate");
      }
      if (state.entries.length >= MAX_ENTRIES) throw new Error("Voice cleanup ledger is full");
      return appendEntry(state, Object.freeze({
        ...reference,
        phase: "staged",
        reason: "vault_write_pending",
        createdAt: validCreatedAt(this.now()),
        attempts: 0,
      }));
    });
    return new ProductVoiceCredentialLease(reference.track, reference.credentialRef, LEASE_AUTHORITY);
  }

  /** Marks the staged candidate locator as the active owner after its configuration generation commits. */
  async markCommitted(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
    readonly expectedGeneration: number;
    readonly committedGeneration: number;
  }): Promise<void> {
    const reference = validateReferenceInput(input);
    const committedGeneration = validCommittedGeneration(input.committedGeneration, reference.expectedGeneration);
    await this.mutate(async (state) => {
      const index = exactEntryIndex(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "staged" || current.expectedGeneration !== reference.expectedGeneration) {
        throw new Error("Voice cleanup ledger entry is unavailable");
      }
      if (state.entries.some((entry, entryIndex) => entryIndex !== index
        && entry.phase === "active" && entry.track === reference.track && entry.committedGeneration === committedGeneration)) {
        throw new Error("Voice cleanup ledger active owner conflicts");
      }
      return replaceEntry(state, index, Object.freeze({
        ...current,
        phase: "active",
        reason: "configuration_committed",
        committedGeneration,
      }));
    });
  }

  /** Adopts a pre-existing committed locator so the first runtime reconfiguration can retire it safely. */
  async adoptCommitted(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
    readonly committedGeneration: number;
  }): Promise<void> {
    const reference = validateReferenceInput({ ...input, expectedGeneration: 0 }, false);
    const committedGeneration = validGeneration(input.committedGeneration, "Committed generation");
    const expectedGeneration = committedGeneration - 1;
    await this.mutate(async (state) => {
      const exactIndex = exactEntryIndex(state.entries, reference);
      const exact = state.entries[exactIndex];
      if (exact !== undefined) {
        // The exact track locator remains authoritative when an unrelated
        // product setting advances the shared configuration generation.
        if (exact.phase === "active") return state;
        throw new Error("Voice cleanup ledger active owner conflicts");
      }
      if (state.entries.some((entry) => entry.track === reference.track && entry.committedGeneration === committedGeneration)) {
        throw new Error("Voice cleanup ledger active owner conflicts");
      }
      if (state.entries.length >= MAX_ENTRIES) throw new Error("Voice cleanup ledger is full");
      return appendEntry(state, Object.freeze({
        ...reference,
        expectedGeneration,
        committedGeneration,
        phase: "active",
        reason: "configuration_committed",
        createdAt: validCreatedAt(this.now()),
        attempts: 0,
      }));
    });
  }

  /** Retires one exact active locator only after its generation no longer owns the live provider. */
  async retire(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
    readonly committedGeneration: number;
  }): Promise<void> {
    const reference = validateReferenceInput({ ...input, expectedGeneration: 1 }, false);
    const committedGeneration = validGeneration(input.committedGeneration, "Committed generation");
    await this.mutate(async (state) => {
      const index = exactEntryIndex(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "active" || current.committedGeneration !== committedGeneration) {
        throw new Error("Voice cleanup ledger entry is unavailable");
      }
      return replaceEntry(state, index, Object.freeze({ ...current, phase: "pending_cleanup", reason: "retired" }));
    });
  }

  /** Makes a staged locator eligible for cleanup when its setup request cannot commit it. */
  async abandonStaged(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
  }): Promise<void> {
    const reference = validateReferenceInput({ ...input, expectedGeneration: 1 }, false);
    await this.mutate(async (state) => {
      const index = exactEntryIndex(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "staged") throw new Error("Voice cleanup ledger entry is unavailable");
      return replaceEntry(state, index, Object.freeze({ ...current, phase: "pending_cleanup", reason: "candidate_abandoned" }));
    });
  }

  /** Returns a bounded snapshot of entries eligible for vault cleanup. */
  async listPending(query: { readonly limit?: number } = {}): Promise<readonly ProductVoiceCleanupEntry[]> {
    const limit = query.limit ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTRIES) throw new TypeError("Voice cleanup ledger limit is invalid");
    return (await this.load()).entries.filter((entry) => entry.phase === "pending_cleanup").slice(0, limit);
  }

  /** Counts one bounded cleanup attempt against the exact pending locator. */
  async markCleanupAttempt(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
  }): Promise<void> {
    const reference = validateReferenceInput({ ...input, expectedGeneration: 1 }, false);
    await this.mutate(async (state) => {
      const index = exactEntryIndex(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "pending_cleanup" || current.attempts >= 1_000_000) {
        throw new Error("Voice cleanup ledger entry is unavailable");
      }
      return replaceEntry(state, index, Object.freeze({ ...current, attempts: current.attempts + 1 }));
    });
  }

  /** Removes one exact pending locator after its vault delete succeeds. */
  async acknowledge(input: {
    readonly candidateId: string;
    readonly track: ProductVoiceCleanupTrack;
    readonly credentialRef: string;
  }): Promise<void> {
    const reference = validateReferenceInput({ ...input, expectedGeneration: 1 }, false);
    await this.mutate(async (state) => {
      const index = exactEntryIndex(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "pending_cleanup") throw new Error("Voice cleanup ledger entry is unavailable");
      return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze(state.entries.filter((_, entryIndex) => entryIndex !== index)) });
    });
  }

  private async mutate(operation: (state: ProductVoiceCleanupLedgerState) => Promise<ProductVoiceCleanupLedgerState>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const lock = await acquireLedgerLock(this.lockPath);
    try {
      const state = await this.load();
      const updated = await operation(state);
      if (updated !== state) await this.write(updated);
    } finally {
      await releaseLedgerLock(this.lockPath, lock);
    }
  }

  private async write(state: ProductVoiceCleanupLedgerState): Promise<void> {
    const source = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Voice cleanup ledger exceeds its size limit");
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(source, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
      await unlink(temporaryPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    }
  }
}

interface LedgerLock {
  readonly file: Awaited<ReturnType<typeof open>>;
  readonly owner: string;
}

async function acquireLedgerLock(lockPath: string): Promise<LedgerLock> {
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      try {
        await file.writeFile(owner, "utf8");
        await file.sync();
        return { file, owner };
      } catch (error) {
        await file.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const stale = await staleLedgerLock(lockPath);
    if (stale) continue;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Voice cleanup ledger is busy");
}

async function staleLedgerLock(lockPath: string): Promise<boolean> {
  let lockAge: number;
  try {
    lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
  if (lockAge <= LOCK_STALE_AFTER_MS) return false;
  const abandonedPath = `${lockPath}.${randomUUID()}.abandoned`;
  try {
    await rename(lockPath, abandonedPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
  await unlink(abandonedPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  return true;
}

async function releaseLedgerLock(lockPath: string, lock: LedgerLock): Promise<void> {
  await lock.file.close();
  let owner: string;
  try {
    owner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (owner !== lock.owner) return;
  await unlink(lockPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
}

function emptyLedger(): ProductVoiceCleanupLedgerState {
  return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze([]) });
}

function validateLedger(value: unknown): ProductVoiceCleanupLedgerState {
  if (!isRecord(value) || value.version !== LEDGER_VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || Object.keys(value).some((key) => key !== "version" && key !== "entries")) throw invalidLedger();
  const seen = new Set<string>();
  const activeOwners = new Set<string>();
  const entries = value.entries.map((candidate) => {
    const entry = validateEntry(candidate);
    if (seen.has(entry.credentialRef)) throw invalidLedger();
    seen.add(entry.credentialRef);
    if (entry.phase === "active") {
      const owner = `${entry.track}:${entry.committedGeneration}`;
      if (activeOwners.has(owner)) throw invalidLedger();
      activeOwners.add(owner);
    }
    return entry;
  });
  return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze(entries) });
}

function validateEntry(value: unknown): ProductVoiceCleanupEntry {
  if (!isRecord(value)) throw invalidLedger();
  const phase = value.phase;
  const hasCommittedGeneration = phase === "active" || (phase === "pending_cleanup" && value.reason === "retired");
  const allowed = phase === "staged" || (phase === "pending_cleanup" && value.reason === "candidate_abandoned")
    ? ["candidateId", "track", "credentialRef", "phase", "reason", "expectedGeneration", "createdAt", "attempts"]
    : hasCommittedGeneration
      ? ["candidateId", "track", "credentialRef", "phase", "reason", "expectedGeneration", "committedGeneration", "createdAt", "attempts"]
      : [];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw invalidLedger();
  const candidateId = validCandidateId(value.candidateId);
  const track = validTrack(value.track);
  const credentialRef = validCredentialRef(candidateId, track, value.credentialRef);
  const expectedGeneration = validExpectedGeneration(value.expectedGeneration);
  const createdAt = validTimestamp(value.createdAt);
  const attempts = validAttempts(value.attempts);
  if (phase === "staged") {
    if (value.reason !== "vault_write_pending") throw invalidLedger();
    return Object.freeze({ candidateId, track, credentialRef, phase, reason: "vault_write_pending", expectedGeneration, createdAt, attempts });
  }
  if (phase === "pending_cleanup" && value.reason === "candidate_abandoned") {
    return Object.freeze({ candidateId, track, credentialRef, phase, reason: "candidate_abandoned", expectedGeneration, createdAt, attempts });
  }
  const committedGeneration = validCommittedGeneration(value.committedGeneration, expectedGeneration);
  if ((phase === "active" && value.reason !== "configuration_committed")
    || (phase === "pending_cleanup" && value.reason !== "retired" && value.reason !== "candidate_abandoned")) {
    throw invalidLedger();
  }
  return Object.freeze({ candidateId, track, credentialRef, phase, reason: value.reason, expectedGeneration, committedGeneration, createdAt, attempts }) as ProductVoiceCleanupEntry;
}

function validateReferenceInput(input: {
  readonly candidateId: unknown;
  readonly track: unknown;
  readonly credentialRef: unknown;
  readonly expectedGeneration: unknown;
}, includeExpectedGeneration = true): { readonly candidateId: string; readonly track: ProductVoiceCleanupTrack; readonly credentialRef: string; readonly expectedGeneration: number } {
  const candidateId = validCandidateId(input.candidateId);
  const track = validTrack(input.track);
  const credentialRef = validCredentialRef(candidateId, track, input.credentialRef);
  return Object.freeze({ candidateId, track, credentialRef, expectedGeneration: includeExpectedGeneration ? validExpectedGeneration(input.expectedGeneration) : 0 });
}

function exactEntryIndex(entries: readonly ProductVoiceCleanupEntry[], reference: Pick<ProductVoiceCleanupEntry, "candidateId" | "track" | "credentialRef">): number {
  return entries.findIndex((entry) => entry.candidateId === reference.candidateId && entry.track === reference.track && entry.credentialRef === reference.credentialRef);
}

function appendEntry(state: ProductVoiceCleanupLedgerState, entry: ProductVoiceCleanupEntry): ProductVoiceCleanupLedgerState {
  return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze([...state.entries, entry]) });
}

function replaceEntry(state: ProductVoiceCleanupLedgerState, index: number, entry: ProductVoiceCleanupEntry): ProductVoiceCleanupLedgerState {
  return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze(state.entries.map((current, currentIndex) => currentIndex === index ? entry : current)) });
}

function validCandidateId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalidLedger();
  return value;
}

function validTrack(value: unknown): ProductVoiceCleanupTrack {
  if (value !== "asr" && value !== "tts") throw invalidLedger();
  return value;
}

function validCredentialRef(candidateId: string, track: ProductVoiceCleanupTrack, value: unknown): string {
  if (typeof value !== "string") throw invalidLedger();
  const match = VOICE_REF.exec(value);
  if (match === null || match[1] !== track || match[2] !== candidateId) throw invalidLedger();
  return value;
}

function validGeneration(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} is invalid`);
  return Number(value);
}

function validExpectedGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError("Expected generation is invalid");
  return Number(value);
}

function validCommittedGeneration(value: unknown, expectedGeneration: number): number {
  const committedGeneration = validGeneration(value, "Committed generation");
  if (committedGeneration !== expectedGeneration + 1) throw invalidLedger();
  return committedGeneration;
}

function validTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalidLedger();
  return value;
}

function validCreatedAt(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError("Voice cleanup ledger time is invalid");
  return value.toISOString();
}

function validAttempts(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) throw invalidLedger();
  return Number(value);
}

function invalidLedger(): Error {
  return new Error("Voice cleanup ledger is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
