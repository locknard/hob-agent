import type { ProfileMetadataWriter } from "./api-key-profile-provisioner.js";
import type { ProfileMetadataRemover } from "./auth-profile-disconnect.js";
import type { AuthProfile } from "./auth-profiles.js";
import { AuthProfileMetadataRepository } from "./auth-profile-metadata-repository.js";
import { PersistedAuthProfileCoordinator } from "./persisted-auth-profile-coordinator.js";

/**
 * Publishes profile metadata to durable stores before updating the active
 * selector. This keeps an OAuth expiry change from being lost on restart when
 * the private locator configuration is newer than SQLite runtime state.
 */
export class AuthProfileRuntimeMetadataWriter implements ProfileMetadataWriter, ProfileMetadataRemover {
  constructor(
    private readonly persisted: AuthProfileMetadataRepository,
    private readonly runtime: PersistedAuthProfileCoordinator,
  ) {}

  async upsert(profile: AuthProfile): Promise<void> {
    await this.persisted.upsert(profile);
    this.runtime.upsert(profile);
  }

  async remove(profileId: string): Promise<void> {
    await this.persisted.remove(profileId);
    this.runtime.remove(profileId);
  }

  async setOrder(provider: string, profileIds: string[]): Promise<void> {
    await this.persisted.setOrder(provider, profileIds);
    this.runtime.setOrder(provider, profileIds);
  }
}
