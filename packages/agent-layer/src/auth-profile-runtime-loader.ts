import { AuthProfileConfigStore } from "./auth-profile-config-store.js";
import { AuthProfileStateStore } from "./auth-profile-state-store.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";

/**
 * Rehydrates runtime profile selection from private locator config plus the
 * SQLite metadata/state store. Secret values are never loaded here.
 */
export async function loadPersistedAuthProfileCoordinator(
  configStore: AuthProfileConfigStore,
  stateStore: AuthProfileStateStore,
): Promise<PersistedAuthProfileCoordinator> {
  const config = await configStore.load();
  for (const profile of config.profiles) stateStore.upsert(profile);
  for (const [provider, profileIds] of Object.entries(config.order)) {
    stateStore.setOrder(provider, profileIds);
  }
  return new PersistedAuthProfileCoordinator(config.profiles, stateStore);
}
