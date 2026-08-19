import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import {
  MacOSKeychainSecretVault,
  type AuthProfile,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import {
  probeDshApiKeyProfile,
  type ProviderProbeResult,
} from "@hob-agent/agent-layer/model-credential-probe";
import { parseModelReference } from "@hob-agent/agent-layer/model-reference";

import { loadSelectedModelCredential } from "./model-credential-profile.js";

type Probe = (options: {
  profile: AuthProfile;
  vault: WritableSecretVault;
  modelId: string;
}) => Promise<ProviderProbeResult>;

/** Executes one paid, metadata-only connection probe for the selected profile. */
export async function probeConfiguredModelCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  vault: WritableSecretVault = new MacOSKeychainSecretVault(),
  probe: Probe = probeDshApiKeyProfile,
): Promise<ProviderProbeResult> {
  const dataDirectory = environment.HOB_DATA_DIR?.trim();
  if (!dataDirectory || !isAbsolute(dataDirectory)) throw new Error("HOB_DATA_DIR must be an absolute private data directory");
  const modelReference = environment.HOB_MODEL?.trim();
  if (!modelReference) throw new Error("HOB_MODEL is required");
  let model;
  try {
    model = parseModelReference(modelReference);
  } catch {
    throw new Error("HOB_MODEL must be a supported provider/model reference");
  }
  const selected = await loadSelectedModelCredential(dataDirectory, model.provider, vault);
  if (!selected) throw new Error(`No selected credential profile for ${model.provider}`);
  return probe({ profile: selected.profile, vault, modelId: model.modelId });
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void probeConfiguredModelCredential().then(
    (result) => {
      console.log(JSON.stringify(result));
      if (result.status !== "ok") process.exitCode = 1;
    },
    () => {
      console.error("hob-agent model credential probe failed");
      process.exitCode = 1;
    },
  );
}
