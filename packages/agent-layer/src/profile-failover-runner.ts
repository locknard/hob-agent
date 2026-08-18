import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";
import type { FailureReason } from "./auth-profiles.js";
import {
  classifyProviderFailure,
  shouldRecordProfileFailure,
  shouldTryNextProfile,
} from "./provider-failover.js";

export interface ProfileFailoverResult<T> {
  profileId: string;
  value: T;
}

/** Stable, secret-free error returned at the provider boundary. */
export class ProfileFailoverError extends Error {
  readonly name = "ProfileFailoverError";

  constructor(
    readonly provider: string,
    readonly profileId: string,
    readonly reason: FailureReason,
  ) {
    super(`Provider operation failed (${reason})`);
  }
}

const COOLDOWN_MS = {
  rate_limit: 60_000,
  overloaded: 30_000,
  timeout: 15_000,
} as const;

/**
 * Executes one provider operation through its explicit profile order. Only
 * retryable failures rotate, and their non-secret state is persisted.
 */
export async function runWithProfileFailover<T>(
  profiles: PersistedAuthProfileCoordinator,
  provider: string,
  execute: (profileId: string) => Promise<T>,
  options: { now?: number } = {},
): Promise<ProfileFailoverResult<T>> {
  const now = options.now ?? Date.now();
  const candidates = profiles.resolveOrder(provider, now);
  if (candidates.length === 0) throw new Error(`No available auth profiles for ${provider}`);

  let lastFailure: { profileId: string; reason: FailureReason } | undefined;
  for (const profileId of candidates) {
    try {
      const value = await execute(profileId);
      profiles.recordSuccess(profileId, now);
      return { profileId, value };
    } catch (error) {
      const reason = classifyProviderFailure(error);
      lastFailure = { profileId, reason };
      const cooldownMs = retryCooldownMs(reason);
      if (shouldRecordProfileFailure(reason)) {
        profiles.recordFailure(profileId, reason, now, cooldownMs ?? 0);
      }
      if (!shouldTryNextProfile(reason) || cooldownMs === undefined) {
        throw new ProfileFailoverError(provider, profileId, reason);
      }
    }
  }
  if (!lastFailure) throw new Error(`No available auth profiles for ${provider}`);
  throw new ProfileFailoverError(provider, lastFailure.profileId, lastFailure.reason);
}

function retryCooldownMs(reason: ReturnType<typeof classifyProviderFailure>): number | undefined {
  return reason === "rate_limit" || reason === "overloaded" || reason === "timeout"
    ? COOLDOWN_MS[reason]
    : undefined;
}
