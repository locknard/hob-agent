import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import {
  AuthProfileStore,
  type AuthProfile,
  type AuthProfileStatus,
  type FailureReason,
  type ProfileSecretAvailability,
} from "./auth-profiles.js";

/**
 * Combines non-secret configured profiles with persisted ordering and health
 * state. The durable store never receives `secretRef`; callers keep secret
 * resolution in their chosen vault.
 */
export class PersistedAuthProfileCoordinator {
  private readonly runtime: AuthProfileStore;

  constructor(
    profiles: AuthProfile[],
    private readonly durable: AuthProfileStateStore,
  ) {
    for (const profile of profiles) durable.upsert(profile);
    const providers = [...new Set(profiles.map((profile) => profile.provider))];
    const order = Object.fromEntries(
      providers
        .map((provider) => [provider, durable.order(provider)] as const)
        .filter(([, ids]) => ids.length > 0),
    );
    this.runtime = new AuthProfileStore(profiles, order);
    for (const provider of providers) {
      for (const profile of durable.list(provider)) {
        if (profile.disabledReason) {
          this.runtime.restoreDisabled(profile.id, profile.disabledReason);
        }
        if (profile.cooldownUntil && profile.cooldownReason) {
          this.runtime.restoreCooldown(profile.id, profile.cooldownReason, profile.cooldownUntil);
        }
      }
    }
  }

  resolveOrder(provider: string, now = Date.now()): string[] {
    return this.runtime.resolveOrder(provider, now);
  }

  status(provider: string, now = Date.now()): AuthProfileStatus[] {
    return this.runtime.status(provider, now);
  }

  /** Implements ProfileMetadataWriter while keeping the active selector current. */
  upsert(profile: AuthProfile): void {
    this.runtime.upsert(profile);
    this.durable.upsert(profile);
  }

  remove(profileId: string): void {
    this.runtime.remove(profileId);
    this.durable.remove(profileId);
  }

  setOrder(provider: string, profileIds: string[]): void {
    this.runtime.setOrder(provider, profileIds);
    this.durable.setOrder(provider, profileIds);
  }

  /** Updates only runtime eligibility from a side-effect-free SecretRef check. */
  setSecretAvailability(profileId: string, availability: ProfileSecretAvailability): void {
    this.runtime.setSecretAvailability(profileId, availability);
  }

  recordFailure(profileId: string, reason: FailureReason, now = Date.now(), cooldownMs = 0): void {
    this.runtime.recordFailure(profileId, reason, now, cooldownMs);
    this.durable.recordFailure(profileId, reason, now, cooldownMs);
  }

  recordSuccess(profileId: string, now = Date.now()): void {
    this.runtime.recordSuccess(profileId);
    this.durable.recordSuccess(profileId, now);
  }
}
