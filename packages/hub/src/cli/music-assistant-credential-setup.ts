import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  MacOSKeychainSecretVault,
  parseSecretRef,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import { readSecretInput } from "./model-credential-setup.js";

/** The only persistent Music Assistant credential locator accepted by Phase 0. */
export const MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF =
  "keychain:hob-agent/media:music-assistant:access-token" as const;

/** Explicit development-only locator; it is never discovered implicitly. */
export const MUSIC_ASSISTANT_ENV_CREDENTIAL_REF = "env:HOB_MUSIC_ASSISTANT_TOKEN" as const;

export type MusicAssistantCredentialRef =
  | typeof MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF
  | typeof MUSIC_ASSISTANT_ENV_CREDENTIAL_REF;

export interface MusicAssistantCredentialSetupResult {
  readonly provider: "music-assistant";
  readonly credentialRef: typeof MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF;
  readonly status: "configured";
}

/**
 * Accept only the fixed Keychain scope or the exact explicit development env
 * reference. The token value itself is never accepted as a credential ref.
 */
export function parseMusicAssistantCredentialRef(
  value: unknown = MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF,
): MusicAssistantCredentialRef {
  if (value === MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF) {
    parseSecretRef(value);
    return MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF;
  }
  if (value === MUSIC_ASSISTANT_ENV_CREDENTIAL_REF) {
    parseSecretRef(value);
    return MUSIC_ASSISTANT_ENV_CREDENTIAL_REF;
  }
  throw new Error("Music Assistant credential reference is not an allowed locator");
}

/** Writes one Music Assistant token to the fixed Keychain scope. */
export async function setupMusicAssistantCredential(
  _environment: Readonly<Record<string, string | undefined>> = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  vault: WritableSecretVault = new MacOSKeychainSecretVault(),
): Promise<MusicAssistantCredentialSetupResult> {
  // Deliberately ignore ambient HOB_MUSIC_ASSISTANT_TOKEN. Development env
  // usage is opt-in through parseMusicAssistantCredentialRef() by the launch
  // seam; setup always reads the token from no-echo stdin into Keychain.
  const credentialRef = MUSIC_ASSISTANT_KEYCHAIN_CREDENTIAL_REF;
  const secret = await readSecretInput(input, process.stderr, "Music Assistant token: ");
  try {
    await vault.write(credentialRef, secret);
  } catch {
    throw new Error("Music Assistant credential storage failed");
  }
  return { provider: "music-assistant", credentialRef, status: "configured" };
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void setupMusicAssistantCredential().then(
    (result) => { console.log(JSON.stringify(result)); },
    () => {
      console.error("hob-agent Music Assistant credential setup failed");
      process.exitCode = 1;
    },
  );
}
