import type { AuthProfile } from "./auth-profiles.js";
import { AuthProfileConfigStore } from "./auth-profile-config-store.js";
import { AuthProfileStateStore } from "./auth-profile-state-store.js";

/**
 * Writes profile locator configuration and public runtime state through one
 * narrow interface. The SQLite store remains free of secret locators.
 */
export class AuthProfileMetadataRepository {
  constructor(
    private readonly config: AuthProfileConfigStore,
    private readonly state: AuthProfileStateStore,
  ) {}

  async upsert(profile: AuthProfile): Promise<void> {
    await this.config.upsert(profile);
    this.state.upsert(profile);
  }

  async setOrder(provider: string, profileIds: string[]): Promise<void> {
    await this.config.setOrder(provider, profileIds);
    this.state.setOrder(provider, profileIds);
  }

  async remove(profileId: string): Promise<void> {
    await this.config.remove(profileId);
    this.state.remove(profileId);
  }
}
