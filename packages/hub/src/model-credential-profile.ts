import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AuthProfileConfigStore,
  MacOSKeychainSecretVault,
  provisionApiKeyProfile,
  type AuthProfile,
  type SecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import type { SupportedModelProvider } from "@hob-agent/agent-layer/model-providers";

export interface SelectedModelCredential {
  readonly profile: AuthProfile;
  readonly vault: SecretVault;
}

export function modelCredentialConfigPath(dataDirectory: string): string {
  return join(dataDirectory, "auth-profiles.json");
}

/** Loads only an explicitly ordered, provider-matching API-key locator. */
export async function loadSelectedModelCredential(
  dataDirectory: string,
  provider: SupportedModelProvider,
  vault: SecretVault = new MacOSKeychainSecretVault(),
): Promise<SelectedModelCredential | undefined> {
  const config = await new AuthProfileConfigStore(modelCredentialConfigPath(dataDirectory)).load();
  const profileId = config.order[provider]?.[0];
  if (profileId === undefined) return undefined;
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  if (
    profile === undefined
    || profile.provider !== provider
    || profile.kind !== "api_key"
    || profile.secretRef !== `keychain:hob-agent/${profile.id}`
  ) {
    throw new Error(`Invalid ordered credential profile for ${provider}`);
  }
  return { profile, vault };
}

/** Rotates the primary provider key while keeping secret material out of files. */
export async function provisionPrimaryModelApiKey(
  dataDirectory: string,
  provider: SupportedModelProvider,
  apiKey: string,
  vault: WritableSecretVault = new MacOSKeychainSecretVault(),
): Promise<AuthProfile> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const profile: AuthProfile = {
    id: `${provider}:primary`,
    provider,
    kind: "api_key",
    secretRef: `keychain:hob-agent/${provider}:primary`,
  };
  const store = new AuthProfileConfigStore(modelCredentialConfigPath(dataDirectory));
  await provisionApiKeyProfile(vault, { upsert: (selected) => store.upsertAndSelect(selected) }, profile, apiKey);
  return profile;
}
