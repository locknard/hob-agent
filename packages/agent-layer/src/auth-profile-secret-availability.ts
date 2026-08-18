import type { AuthProfile, ProfileSecretAvailability } from "./auth-profiles.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";
import {
  readOnlySecretRefAvailability,
  type ReadOnlySecretRefAvailabilityOptions,
} from "./secret-ref.js";

export interface AuthProfileSecretObservation {
  profileId: string;
  availability: ProfileSecretAvailability;
}

/**
 * Feeds a side-effect-free SecretRef observation into runtime selection.
 * The result intentionally omits the locator and never resolves Keychain data.
 */
export function observeAuthProfileSecretAvailability(
  profile: AuthProfile,
  profiles: PersistedAuthProfileCoordinator,
  options: ReadOnlySecretRefAvailabilityOptions,
): AuthProfileSecretObservation {
  const availability = readOnlySecretRefAvailability(profile.secretRef, options).status;
  profiles.setSecretAvailability(profile.id, availability);
  return { profileId: profile.id, availability };
}
