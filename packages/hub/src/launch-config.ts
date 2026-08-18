import {
  createLaunchEnvironmentSnapshot,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment";
import {
  parseModelReference,
} from "@hob-agent/agent-layer/model-reference";
import {
  providerSetup,
  type SupportedModelProvider,
} from "@hob-agent/agent-layer/model-providers";

import type { HomeAssistantBridgeOptions } from "./home-assistant-bridge.js";

const REQUIRED_HOME_ENV = ["HOB_HA_URL", "HOB_HA_TOKEN", "HOB_MODEL"] as const;

export type LaunchEnvironment = Readonly<Record<string, string | undefined>>;

export interface HomeHubLaunchConfig {
  readonly homeAssistant: HomeAssistantBridgeOptions;
  readonly agent: {
    readonly provider: SupportedModelProvider;
    readonly model: string;
  };
  /** DSH sees only the selected provider's standard credential alias. */
  readonly launchEnvironment: LaunchEnvironmentSnapshot;
}

/**
 * Reads the executable launch contract without ever enumerating the ambient
 * environment. The selected provider key is the only non-HOB value read.
 */
export function readHomeHubLaunchConfig(environment: LaunchEnvironment): HomeHubLaunchConfig {
  const baseUrl = requiredValue(environment, "HOB_HA_URL").trim();
  const accessToken = requiredValue(environment, "HOB_HA_TOKEN").trim();
  const modelReference = requiredValue(environment, "HOB_MODEL");

  let model: ReturnType<typeof parseModelReference>;
  try {
    model = parseModelReference(modelReference);
  } catch {
    throw new Error("Invalid HOB_MODEL; expected a supported provider/model reference");
  }

  const credentialEnv = providerSetup(model.provider).credentialEnv;
  const apiKey = requiredValue(environment, credentialEnv).trim();
  const launchEnvironment = createLaunchEnvironmentSnapshot([{
    source: "process",
    values: { [credentialEnv]: apiKey },
  }]);

  return {
    homeAssistant: { baseUrl, accessToken },
    agent: { provider: model.provider, model: model.modelId },
    launchEnvironment,
  };
}

function requiredValue(environment: LaunchEnvironment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required launch environment variable: ${name}`);
  }
  return value;
}

export { REQUIRED_HOME_ENV };
