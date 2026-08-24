import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  formatDurableSecretRef,
  MacOSKeychainSecretVault,
  parseSecretRef,
  type DurableSecretRefSource,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";

import { readSecretInput } from "./model-credential-setup.js";

const SCOPE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BridgeCredentialSetupResult {
  readonly bridgeId: string;
  readonly alias: string;
  readonly credentialRef: string;
  readonly status: "configured";
}

/** Writes one bridge/alias-scoped secret to Keychain and returns locator metadata only. */
export async function setupBridgeCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  vault: WritableSecretVault = new MacOSKeychainSecretVault(),
  credentialRefSource: DurableSecretRefSource = "keychain",
): Promise<BridgeCredentialSetupResult> {
  const bridgeId = environment.HOB_BRIDGE_ID?.trim();
  const alias = environment.HOB_BRIDGE_CREDENTIAL_ALIAS?.trim();
  if (!bridgeId || !SCOPE_PART.test(bridgeId)) {
    throw new Error("HOB_BRIDGE_ID must be a canonical bridge identifier");
  }
  if (!alias || !SCOPE_PART.test(alias)) {
    throw new Error("HOB_BRIDGE_CREDENTIAL_ALIAS must be a canonical credential alias");
  }
  const credentialRef = formatDurableSecretRef(credentialRefSource, `hob-agent/bridge:${bridgeId}:${alias}`);
  parseSecretRef(credentialRef);
  const secret = await readSecretInput(input, process.stderr, "Bridge credential: ");
  await vault.write(credentialRef, secret);
  return { bridgeId, alias, credentialRef, status: "configured" };
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void setupBridgeCredential().then(
    (result) => { console.log(JSON.stringify(result)); },
    () => {
      console.error("hob-agent bridge credential setup failed");
      process.exitCode = 1;
    },
  );
}
