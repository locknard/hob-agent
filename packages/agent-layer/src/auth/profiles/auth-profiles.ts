export type AuthKind = "api_key" | "oauth" | "external_cli" | "token";
export type FailureReason = "auth" | "rate_limit" | "billing" | "timeout" | "network" | "format" | "overloaded" | "unknown";
export type ProfileSecretAvailability = "available" | "missing" | "blocked" | "unknown";

export interface AuthProfile {
  id: string;
  provider: string;
  kind: AuthKind;
  /** Opaque locator; secret material is resolved only by a future SecretStore. */
  secretRef?: string;
  expiresAt?: number;
}

interface ProfileState {
  cooldownUntil?: number;
  cooldownReason?: FailureReason;
  disabledReason?: Extract<FailureReason, "auth" | "billing">;
}

export interface AuthProfileStatus {
  id: string;
  provider: string;
  kind: AuthKind;
  availability: "ready" | "cooldown" | "expired" | "disabled" | "needs_auth";
}

/**
 * Runtime-only profile selection state adapted from OpenClaw's profile ordering
 * and cooldown model. Persistence and secret resolution stay outside this class.
 */
export class AuthProfileStore {
  private readonly byId: Map<string, AuthProfile>;
  private readonly state = new Map<string, ProfileState>();
  private readonly secretAvailability = new Map<string, ProfileSecretAvailability>();

  constructor(profiles: AuthProfile[], private readonly order: Record<string, string[]> = {}) {
    this.byId = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  resolveOrder(provider: string, now = Date.now()): string[] {
    const candidates = this.orderedProfiles(provider)
      .filter((profile) => !isExpired(profile, now))
      .filter((profile) => !needsAuth(profile, this.secretAvailability.get(profile.id)))
      .map((profile) => ({ profile, state: this.activeState(profile.id, now) }));
    return candidates
      .filter(({ state }) => !state?.disabledReason)
      .sort((left, right) => Number(Boolean(left.state?.cooldownUntil)) - Number(Boolean(right.state?.cooldownUntil))
        || (left.state?.cooldownUntil ?? 0) - (right.state?.cooldownUntil ?? 0))
      .map(({ profile }) => profile.id);
  }

  recordFailure(profileId: string, reason: FailureReason, now = Date.now(), cooldownMs = 0): void {
    if (!this.byId.has(profileId)) throw new Error(`Unknown auth profile: ${profileId}`);
    this.state.set(profileId, {
      ...(reason === "auth" || reason === "billing"
        ? { disabledReason: reason }
        : {
            cooldownReason: reason,
            ...(cooldownMs > 0 ? { cooldownUntil: now + cooldownMs } : {}),
          }),
    });
  }

  /** Restores a previously persisted cooldown without reconstructing any secret material. */
  restoreCooldown(profileId: string, reason: FailureReason, cooldownUntil: number): void {
    if (!this.byId.has(profileId)) throw new Error(`Unknown auth profile: ${profileId}`);
    this.state.set(profileId, { cooldownReason: reason, cooldownUntil });
  }

  restoreDisabled(profileId: string, reason: Extract<FailureReason, "auth" | "billing">): void {
    if (!this.byId.has(profileId)) throw new Error(`Unknown auth profile: ${profileId}`);
    this.state.set(profileId, { disabledReason: reason });
  }

  recordSuccess(profileId: string): void {
    if (!this.byId.has(profileId)) throw new Error(`Unknown auth profile: ${profileId}`);
    this.state.delete(profileId);
  }

  /** Replaces non-secret profile metadata without resetting its health state. */
  upsert(profile: AuthProfile): void {
    this.byId.set(profile.id, profile);
  }

  /** Removes a profile from selection while scrubbing all explicit ordering state. */
  remove(profileId: string): void {
    this.byId.delete(profileId);
    this.state.delete(profileId);
    this.secretAvailability.delete(profileId);
    for (const [provider, profileIds] of Object.entries(this.order)) {
      const next = profileIds.filter((id) => id !== profileId);
      if (next.length === 0) delete this.order[provider];
      else this.order[provider] = next;
    }
  }

  setOrder(provider: string, profileIds: string[]): void {
    for (const profileId of profileIds) {
      if (this.byId.get(profileId)?.provider !== provider) {
        throw new Error(`Unknown ${provider} auth profile: ${profileId}`);
      }
    }
    this.order[provider] = [...profileIds];
  }

  /** Applies a passive SecretRef observation without ever resolving the secret. */
  setSecretAvailability(profileId: string, availability: ProfileSecretAvailability): void {
    if (!this.byId.has(profileId)) throw new Error(`Unknown auth profile: ${profileId}`);
    this.secretAvailability.set(profileId, availability);
  }

  status(provider: string, now = Date.now()): AuthProfileStatus[] {
    return this.orderedProfiles(provider).map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      kind: profile.kind,
      availability: isExpired(profile, now)
        ? "expired"
        : needsAuth(profile, this.secretAvailability.get(profile.id))
          ? "needs_auth"
        : this.activeState(profile.id, now)?.disabledReason
          ? "disabled"
        : this.activeState(profile.id, now)?.cooldownUntil
          ? "cooldown"
          : "ready",
    }));
  }

  private orderedProfiles(provider: string): AuthProfile[] {
    const providerProfiles = [...this.byId.values()].filter((profile) => profile.provider === provider);
    const explicit = this.order[provider];
    if (!explicit) return providerProfiles;
    return explicit.map((id) => this.byId.get(id)).filter((profile): profile is AuthProfile => profile?.provider === provider);
  }

  private activeState(profileId: string, now: number): ProfileState | undefined {
    const state = this.state.get(profileId);
    if (state?.cooldownUntil && state.cooldownUntil <= now) {
      this.state.delete(profileId);
      return undefined;
    }
    return state;
  }
}

function isExpired(profile: AuthProfile, now: number): boolean {
  return profile.kind === "oauth" && profile.expiresAt !== undefined && profile.expiresAt <= now;
}

function needsAuth(profile: AuthProfile, availability?: ProfileSecretAvailability): boolean {
  if (availability === "missing" || availability === "blocked") return true;
  if (profile.kind === "api_key" || profile.kind === "token") return !profile.secretRef;
  return profile.kind === "oauth" && (!profile.secretRef || profile.expiresAt === undefined);
}
