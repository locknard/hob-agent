import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "hob.product-model-cleanup/v1" as const;
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 16_384;
const LOCK_STALE_AFTER_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEASE_AUTHORITY = Symbol("product-model-cleanup-ledger");

export type ProductModelCleanupPhase = "staged" | "active" | "pending_cleanup";
export type ProductModelCleanupReason = "vault_write_pending" | "configuration_committed" | "candidate_abandoned" | "retired";

/** Metadata-only durable ownership record for one active or replacement model locator. */
export interface ProductModelCleanupEntry {
  readonly candidateId: string;
  readonly credentialRef: string;
  readonly phase: ProductModelCleanupPhase;
  readonly reason: ProductModelCleanupReason;
  readonly expectedGeneration: number;
  readonly committedGeneration?: number;
  readonly createdAt: string;
  readonly attempts: number;
}

export interface ProductModelCleanupLedgerState {
  readonly version: typeof VERSION;
  readonly entries: readonly ProductModelCleanupEntry[];
}

/** An unforgeable, single-use authorization for the exact locator reserved on disk. */
export class ProductModelCredentialLease {
  readonly #credentialRef: string;
  #consumed = false;

  constructor(credentialRef: string, authority: symbol) {
    if (authority !== LEASE_AUTHORITY) throw new TypeError("Model credential lease is invalid");
    this.#credentialRef = credentialRef;
  }

  consume(credentialRef: string): void {
    if (this.#consumed || credentialRef !== this.#credentialRef) throw new TypeError("Model credential lease is invalid");
    this.#consumed = true;
  }
}

export class ProductModelCleanupLedger {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(directory, "product-model-cleanup-ledger.json");
    this.lockPath = join(directory, "product-model-cleanup-ledger.lock");
  }

  async load(): Promise<ProductModelCleanupLedgerState> {
    let source: string;
    try { source = await readFile(this.path, "utf8"); } catch (error) {
      if (isErrno(error, "ENOENT")) return empty();
      throw error;
    }
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw invalid();
    try { return validate(JSON.parse(source) as unknown); } catch (error) {
      if (error instanceof SyntaxError) throw invalid();
      throw error;
    }
  }

  /** Persists ownership before vault.write can make a candidate secret recoverable. */
  async reserve(input: { readonly candidateId: string; readonly credentialRef: string; readonly expectedGeneration: number }): Promise<ProductModelCredentialLease> {
    const entry = validReference(input);
    await this.mutate((state) => {
      if (state.entries.length >= MAX_ENTRIES) throw new Error("Model cleanup ledger is full");
      if (state.entries.some((current) => current.credentialRef === entry.credentialRef)) throw new Error("Model cleanup ledger reference is duplicate");
      return append(state, Object.freeze({ ...entry, phase: "staged", reason: "vault_write_pending", createdAt: timestamp(this.now()), attempts: 0 }));
    });
    return new ProductModelCredentialLease(entry.credentialRef, LEASE_AUTHORITY);
  }

  async markCommitted(input: { readonly candidateId: string; readonly credentialRef: string; readonly expectedGeneration: number; readonly committedGeneration: number }): Promise<void> {
    const reference = validReference(input);
    const committedGeneration = validCommitted(input.committedGeneration, reference.expectedGeneration);
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "staged") throw new Error("Model cleanup ledger entry is unavailable");
      if (state.entries.some((entry, entryIndex) => entryIndex !== index && entry.phase === "active" && entry.committedGeneration === committedGeneration)) {
        throw new Error("Model cleanup ledger active owner conflicts");
      }
      return replace(state, index, Object.freeze({ ...current, phase: "active", reason: "configuration_committed", committedGeneration }));
    });
  }

  /** Records a pre-existing operational config as an active owner after a process restart. */
  async adoptCommitted(input: { readonly candidateId: string; readonly credentialRef: string; readonly committedGeneration: number }): Promise<void> {
    const reference = validReference({ ...input, expectedGeneration: 0 });
    const committedGeneration = validGeneration(input.committedGeneration, "Committed generation");
    const expectedGeneration = committedGeneration - 1;
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      const existing = state.entries[index];
      if (existing !== undefined) {
        // The exact locator is the durable ownership identity. Other product
        // settings may advance the shared configuration generation without
        // replacing this model credential.
        if (existing.phase === "active") return state;
        if (existing.phase === "staged" && existing.expectedGeneration === expectedGeneration) {
          return replace(state, index, Object.freeze({ ...existing, phase: "active", reason: "configuration_committed", committedGeneration }));
        }
        throw new Error("Model cleanup ledger active owner conflicts");
      }
      if (state.entries.length >= MAX_ENTRIES || state.entries.some((entry) => entry.phase === "active" && entry.committedGeneration === committedGeneration)) {
        throw new Error("Model cleanup ledger active owner conflicts");
      }
      return append(state, Object.freeze({ ...reference, expectedGeneration, committedGeneration, phase: "active", reason: "configuration_committed", createdAt: timestamp(this.now()), attempts: 0 }));
    });
  }

  async retire(input: { readonly candidateId: string; readonly credentialRef: string; readonly committedGeneration: number }): Promise<void> {
    const reference = validReference({ ...input, expectedGeneration: 0 });
    const committedGeneration = validGeneration(input.committedGeneration, "Committed generation");
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "active" || current.committedGeneration !== committedGeneration) throw new Error("Model cleanup ledger entry is unavailable");
      return replace(state, index, Object.freeze({ ...current, phase: "pending_cleanup", reason: "retired" }));
    });
  }

  async abandonStaged(input: { readonly candidateId: string; readonly credentialRef: string }): Promise<void> {
    const reference = validReference({ ...input, expectedGeneration: 0 });
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "staged") throw new Error("Model cleanup ledger entry is unavailable");
      return replace(state, index, Object.freeze({ ...current, phase: "pending_cleanup", reason: "candidate_abandoned" }));
    });
  }

  async listPending(query: { readonly limit?: number } = {}): Promise<readonly ProductModelCleanupEntry[]> {
    const limit = query.limit ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTRIES) throw new TypeError("Model cleanup ledger limit is invalid");
    return (await this.load()).entries.filter((entry) => entry.phase === "pending_cleanup").slice(0, limit);
  }

  async markCleanupAttempt(input: { readonly candidateId: string; readonly credentialRef: string }): Promise<void> {
    const reference = validReference({ ...input, expectedGeneration: 0 });
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      const current = state.entries[index];
      if (current === undefined || current.phase !== "pending_cleanup" || current.attempts >= 1_000_000) throw new Error("Model cleanup ledger entry is unavailable");
      return replace(state, index, Object.freeze({ ...current, attempts: current.attempts + 1 }));
    });
  }

  async acknowledge(input: { readonly candidateId: string; readonly credentialRef: string }): Promise<void> {
    const reference = validReference({ ...input, expectedGeneration: 0 });
    await this.mutate((state) => {
      const index = find(state.entries, reference);
      if (index < 0 || state.entries[index]?.phase !== "pending_cleanup") throw new Error("Model cleanup ledger entry is unavailable");
      return Object.freeze({ version: VERSION, entries: Object.freeze(state.entries.filter((_, entryIndex) => entryIndex !== index)) });
    });
  }

  private async mutate(operation: (state: ProductModelCleanupLedgerState) => ProductModelCleanupLedgerState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const lock = await acquire(this.lockPath);
    try {
      const state = await this.load();
      const updated = operation(state);
      if (updated !== state) await this.write(updated);
    } finally { await release(this.lockPath, lock); }
  }

  private async write(state: ProductModelCleanupLedgerState): Promise<void> {
    const source = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Model cleanup ledger exceeds its size limit");
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(source, "utf8"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      const handle = await open(this.directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } finally { await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; }); }
  }
}

interface Lock { readonly file: Awaited<ReturnType<typeof open>>; readonly owner: string; }

async function acquire(path: string): Promise<Lock> {
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(owner, "utf8"); await file.sync(); return { file, owner }; } catch (error) { await file.close(); await unlink(path).catch(() => undefined); throw error; }
    } catch (error) { if (!isErrno(error, "EEXIST")) throw error; }
    try {
      if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_AFTER_MS) {
        const abandoned = `${path}.${randomUUID()}.abandoned`;
        await rename(path, abandoned).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
        await unlink(abandoned).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
        continue;
      }
    } catch (error) { if (!isErrno(error, "ENOENT")) throw error; continue; }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Model cleanup ledger is busy");
}

async function release(path: string, lock: Lock): Promise<void> {
  await lock.file.close();
  let owner: string;
  try { owner = await readFile(path, "utf8"); } catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
  if (owner === lock.owner) await unlink(path).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
}

function empty(): ProductModelCleanupLedgerState { return Object.freeze({ version: VERSION, entries: Object.freeze([]) }); }
function append(state: ProductModelCleanupLedgerState, entry: ProductModelCleanupEntry): ProductModelCleanupLedgerState { return Object.freeze({ version: VERSION, entries: Object.freeze([...state.entries, entry]) }); }
function replace(state: ProductModelCleanupLedgerState, index: number, entry: ProductModelCleanupEntry): ProductModelCleanupLedgerState { return Object.freeze({ version: VERSION, entries: Object.freeze(state.entries.map((current, currentIndex) => currentIndex === index ? entry : current)) }); }
function find(entries: readonly ProductModelCleanupEntry[], reference: Pick<ProductModelCleanupEntry, "candidateId" | "credentialRef">): number { return entries.findIndex((entry) => entry.candidateId === reference.candidateId && entry.credentialRef === reference.credentialRef); }

function validate(value: unknown): ProductModelCleanupLedgerState {
  if (!record(value) || value.version !== VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES || Object.keys(value).some((key) => key !== "version" && key !== "entries")) throw invalid();
  const seen = new Set<string>();
  const active = new Set<number>();
  const entries = value.entries.map((value) => {
    const entry = validEntry(value);
    if (seen.has(entry.credentialRef) || (entry.phase === "active" && active.has(entry.committedGeneration!))) throw invalid();
    seen.add(entry.credentialRef); if (entry.phase === "active") active.add(entry.committedGeneration!);
    return entry;
  });
  return Object.freeze({ version: VERSION, entries: Object.freeze(entries) });
}

function validEntry(value: unknown): ProductModelCleanupEntry {
  if (!record(value)) throw invalid();
  const phase = value.phase;
  const hasCommitted = phase === "active" || (phase === "pending_cleanup" && value.reason === "retired");
  const allowed = hasCommitted ? ["candidateId", "credentialRef", "phase", "reason", "expectedGeneration", "committedGeneration", "createdAt", "attempts"] : ["candidateId", "credentialRef", "phase", "reason", "expectedGeneration", "createdAt", "attempts"];
  if ((phase !== "staged" && phase !== "active" && phase !== "pending_cleanup") || Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
  const reference = validReference(value);
  const expectedGeneration = validGeneration(value.expectedGeneration, "Expected generation", true);
  const createdAt = timestamp(value.createdAt);
  if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0 || Number(value.attempts) > 1_000_000) throw invalid();
  if (phase === "staged" && value.reason === "vault_write_pending") return Object.freeze({ ...reference, phase, reason: value.reason, expectedGeneration, createdAt, attempts: Number(value.attempts) });
  if (phase === "pending_cleanup" && value.reason === "candidate_abandoned") return Object.freeze({ ...reference, phase, reason: value.reason, expectedGeneration, createdAt, attempts: Number(value.attempts) });
  const committedGeneration = validCommitted(value.committedGeneration, expectedGeneration);
  if (phase === "active" && value.reason === "configuration_committed") return Object.freeze({ ...reference, phase, reason: value.reason, expectedGeneration, committedGeneration, createdAt, attempts: Number(value.attempts) });
  if (phase === "pending_cleanup" && value.reason === "retired") return Object.freeze({ ...reference, phase, reason: value.reason, expectedGeneration, committedGeneration, createdAt, attempts: Number(value.attempts) });
  throw invalid();
}

function validReference(value: unknown): { readonly candidateId: string; readonly credentialRef: string; readonly expectedGeneration: number } {
  if (!record(value)) throw invalid();
  const candidateId = typeof value.candidateId === "string" && ID.test(value.candidateId) ? value.candidateId : undefined;
  const credentialRef = typeof value.credentialRef === "string" ? value.credentialRef : undefined;
  if (candidateId === undefined || credentialRef === undefined || !modelCredentialReference(candidateId, credentialRef)) throw invalid();
  return { candidateId, credentialRef, expectedGeneration: validGeneration(value.expectedGeneration, "Expected generation", true) };
}
function modelCredentialReference(candidateId: string, credentialRef: string): boolean {
  const nonce = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
  return new RegExp(`^keychain:hob-agent/(?:model|setup-model):${candidateId}:${nonce}$`, "u").test(credentialRef);
}
function validGeneration(value: unknown, label: string, zero = false): number { if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) throw invalid(label); return Number(value); }
function validCommitted(value: unknown, expected: number): number { const committed = validGeneration(value, "Committed generation"); if (committed !== expected + 1) throw invalid(); return committed; }
function timestamp(value: unknown): string { if (!(value instanceof Date) && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) throw invalid(); const source = value instanceof Date ? value.toISOString() : value; return source; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message = "Model cleanup ledger is invalid"): Error { return new Error(message); }
function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException { return value instanceof Error && "code" in value && value.code === code; }
