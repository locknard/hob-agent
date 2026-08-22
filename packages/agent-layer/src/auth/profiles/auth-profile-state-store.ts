import { DatabaseSync } from "node:sqlite";

import type { AuthKind, AuthProfile, FailureReason } from "./auth-profiles.js";

export interface PersistedProfileStatus {
  id: string;
  provider: string;
  kind: AuthKind;
  expiresAt: number | undefined;
  cooldownUntil: number | undefined;
  cooldownReason: FailureReason | undefined;
  lastSuccessAt: number | undefined;
  failureCount: number;
  disabledReason: Extract<FailureReason, "auth" | "billing"> | undefined;
}

/**
 * SQLite metadata/state store adapted from OpenClaw's split credential/state
 * persistence. Secret values and secret references deliberately never enter it.
 */
export class AuthProfileStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profiles (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_profile_order (
        provider TEXT NOT NULL, position INTEGER NOT NULL, profile_id TEXT NOT NULL,
        PRIMARY KEY(provider, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_profile_state (
        profile_id TEXT PRIMARY KEY, cooldown_until INTEGER, cooldown_reason TEXT,
        last_success_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT
      ) STRICT;
    `);
    this.ensureStateColumns();
  }

  upsert(profile: AuthProfile): void {
    this.db.prepare(`INSERT INTO auth_profiles (id, provider, kind, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, kind=excluded.kind, expires_at=excluded.expires_at`)
      .run(profile.id, profile.provider, profile.kind, profile.expiresAt ?? null);
  }

  setOrder(provider: string, profileIds: string[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM auth_profile_order WHERE provider = ?").run(provider);
      const insert = this.db.prepare("INSERT INTO auth_profile_order (provider, position, profile_id) VALUES (?, ?, ?)");
      profileIds.forEach((profileId, position) => insert.run(provider, position, profileId));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  order(provider: string): string[] {
    return this.db.prepare("SELECT profile_id FROM auth_profile_order WHERE provider = ? ORDER BY position")
      .all(provider).map((row) => (row as { profile_id: string }).profile_id);
  }

  recordFailure(profileId: string, reason: FailureReason, now: number, cooldownMs: number): void {
    const disabledReason = reason === "auth" || reason === "billing" ? reason : null;
    this.db.prepare(`INSERT INTO auth_profile_state (profile_id, cooldown_until, cooldown_reason, disabled_reason, failure_count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(profile_id) DO UPDATE SET cooldown_until=excluded.cooldown_until, cooldown_reason=excluded.cooldown_reason,
        disabled_reason=COALESCE(auth_profile_state.disabled_reason, excluded.disabled_reason),
        failure_count=COALESCE(auth_profile_state.failure_count, 0) + 1`)
      .run(profileId, cooldownMs > 0 ? now + cooldownMs : null, reason, disabledReason);
  }

  recordSuccess(profileId: string, now: number): void {
    this.db.prepare(`INSERT INTO auth_profile_state (profile_id, last_success_at, failure_count) VALUES (?, ?, 0)
      ON CONFLICT(profile_id) DO UPDATE SET cooldown_until=NULL, cooldown_reason=NULL,
        last_success_at=excluded.last_success_at, failure_count=0, disabled_reason=NULL`)
      .run(profileId, now);
  }

  /** Deletes public profile metadata, health, and explicit ordering references. */
  remove(profileId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM auth_profile_order WHERE profile_id = ?").run(profileId);
      this.db.prepare("DELETE FROM auth_profile_state WHERE profile_id = ?").run(profileId);
      this.db.prepare("DELETE FROM auth_profiles WHERE id = ?").run(profileId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  list(provider: string): PersistedProfileStatus[] {
    return this.db.prepare(`SELECT p.id, p.provider, p.kind, p.expires_at, s.cooldown_until, s.cooldown_reason,
      s.last_success_at, s.failure_count
      , s.disabled_reason
      FROM auth_profiles p LEFT JOIN auth_profile_state s ON s.profile_id = p.id WHERE p.provider = ? ORDER BY p.id`)
      .all(provider).map((row) => {
        const value = row as Record<string, unknown>;
        return { id: value.id as string, provider: value.provider as string, kind: value.kind as AuthKind,
          expiresAt: (value.expires_at as number | null) ?? undefined,
          cooldownUntil: (value.cooldown_until as number | null) ?? undefined,
          cooldownReason: (value.cooldown_reason as FailureReason | null) ?? undefined,
          lastSuccessAt: (value.last_success_at as number | null) ?? undefined,
          failureCount: (value.failure_count as number | null) ?? 0,
          disabledReason: (value.disabled_reason as Extract<FailureReason, "auth" | "billing"> | null) ?? undefined };
      });
  }

  contains(text: string): boolean {
    const persisted = [
      this.db.prepare("SELECT * FROM auth_profiles").all(),
      this.db.prepare("SELECT * FROM auth_profile_order").all(),
      this.db.prepare("SELECT * FROM auth_profile_state").all(),
    ];
    return JSON.stringify(persisted).includes(text);
  }
  close(): void { this.db.close(); }

  private ensureStateColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(auth_profile_state)").all()
      .map((row) => (row as { name: string }).name);
    if (!columns.includes("last_success_at")) this.db.exec("ALTER TABLE auth_profile_state ADD COLUMN last_success_at INTEGER");
    if (!columns.includes("failure_count")) this.db.exec("ALTER TABLE auth_profile_state ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("disabled_reason")) this.db.exec("ALTER TABLE auth_profile_state ADD COLUMN disabled_reason TEXT");
  }
}
