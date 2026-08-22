import type { SupportedModelProvider } from "../../model/model-providers.js";
import { providerAdapter } from "../../model/provider-adapters.js";

export interface ExternalCliProfile {
  id: string;
  provider: SupportedModelProvider;
  kind: "external_cli";
}

export interface ExternalCliDiscoverer {
  discover(
    provider: SupportedModelProvider,
    options: { allowKeychainPrompt: boolean },
  ): Promise<ExternalCliProfile[]>;
}

/**
 * Discover only the explicitly requested providers. Passive/status reads must
 * never cause credential-store prompts or scan unrelated installed CLIs.
 */
export async function discoverExternalCliProfiles(
  providers: SupportedModelProvider[],
  discoverer: ExternalCliDiscoverer,
): Promise<ExternalCliProfile[]> {
  const cliProviders = [...new Set(providers)].filter((provider) =>
    providerAdapter(provider).authMethods.includes("external_cli"),
  );
  const profiles = await Promise.all(
    cliProviders.map((provider) =>
      discoverer.discover(provider, { allowKeychainPrompt: false }),
    ),
  );
  return profiles.flat();
}
