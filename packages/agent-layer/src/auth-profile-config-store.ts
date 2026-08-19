import { chmod, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { AuthKind, AuthProfile } from "./auth-profiles.js";

export interface AuthProfileConfig {
  profiles: AuthProfile[];
  order: Record<string, string[]>;
}

export interface AuthProfileConfigStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

/**
 * Private local configuration for non-secret profile locators and ordering.
 * OAuth/API-key material is intentionally not part of this format; unknown
 * fields are discarded during load so accidentally added secrets do not round
 * trip through this store.
 */
export class AuthProfileConfigStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly options: AuthProfileConfigStoreOptions = {},
  ) {}

  async load(): Promise<AuthProfileConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [], order: {} };
      throw error;
    }
    return decodeConfig(JSON.parse(raw) as unknown);
  }

  async upsert(profile: AuthProfile): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.load();
      const profiles = config.profiles.filter((entry) => entry.id !== profile.id);
      profiles.push(copyProfile(profile));
      await this.save({ ...config, profiles });
    });
  }

  async setOrder(provider: string, profileIds: string[]): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.load();
      await this.save({
        ...config,
        order: { ...config.order, [provider]: [...profileIds] },
      });
    });
  }

  /** Publishes a profile and selects it in one private-file transaction. */
  async upsertAndSelect(profile: AuthProfile): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.load();
      const profiles = config.profiles.filter((entry) => entry.id !== profile.id);
      profiles.push(copyProfile(profile));
      const prior = config.order[profile.provider] ?? [];
      await this.save({
        profiles,
        order: {
          ...config.order,
          [profile.provider]: [profile.id, ...prior.filter((id) => id !== profile.id)],
        },
      });
    });
  }

  /** Removes a profile locator and every explicit ordering reference to it. */
  async remove(profileId: string): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.load();
      const order = Object.fromEntries(
        Object.entries(config.order)
          .map(([provider, ids]) => [provider, ids.filter((id) => id !== profileId)] as const)
          .filter(([, ids]) => ids.length > 0),
      );
      await this.save({
        profiles: config.profiles.filter((profile) => profile.id !== profileId),
        order,
      });
    });
  }

  private async save(config: AuthProfileConfig): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, ...config }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.writes.then(() => this.withFileLock(task));
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withFileLock(task: () => Promise<void>): Promise<void> {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 5_000);
    const retryMs = this.options.lockRetryMs ?? 25;
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await task();
          return;
        } finally {
          await handle.close();
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Auth profile configuration lock timed out");
        await wait(retryMs);
      }
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeConfig(value: unknown): AuthProfileConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid auth profile configuration");
  const candidate = value as { version?: unknown; profiles?: unknown; order?: unknown };
  if (candidate.version !== 1) throw new Error("Unsupported auth profile configuration version");
  if (!Array.isArray(candidate.profiles) || !candidate.order || typeof candidate.order !== "object") {
    throw new Error("Invalid auth profile configuration");
  }
  return {
    profiles: candidate.profiles.map(decodeProfile),
    order: Object.fromEntries(
      Object.entries(candidate.order as Record<string, unknown>)
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string"))
        .map(([provider, ids]) => [provider, [...ids]]),
    ),
  };
}

function decodeProfile(value: unknown): AuthProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid auth profile configuration");
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.id !== "string" ||
    typeof profile.provider !== "string" ||
    !isAuthKind(profile.kind) ||
    (profile.secretRef !== undefined && typeof profile.secretRef !== "string") ||
    (profile.expiresAt !== undefined && typeof profile.expiresAt !== "number")
  ) throw new Error("Invalid auth profile configuration");
  return {
    id: profile.id,
    provider: profile.provider,
    kind: profile.kind,
    ...(typeof profile.secretRef === "string" ? { secretRef: profile.secretRef } : {}),
    ...(typeof profile.expiresAt === "number" ? { expiresAt: profile.expiresAt } : {}),
  };
}

function copyProfile(profile: AuthProfile): AuthProfile {
  return decodeProfile(profile);
}

function isAuthKind(value: unknown): value is AuthKind {
  return value === "api_key" || value === "oauth" || value === "external_cli" || value === "token";
}
