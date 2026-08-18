import type { ClaudeCliOAuthCredential } from "./claude-cli-credential-reader.js";
import type { ExternalCliDiscoverer, ExternalCliProfile } from "./external-cli-discovery.js";
import type { SupportedModelProvider } from "./model-providers.js";

export interface ClaudeCliCredentialReader {
  read(): Promise<ClaudeCliOAuthCredential | undefined>;
}

/**
 * Concrete no-prompt Claude Code discovery adapter. The reader is file-only,
 * so the `allowKeychainPrompt: false` contract is upheld by construction.
 */
export class ClaudeCliExternalDiscoverer implements ExternalCliDiscoverer {
  constructor(
    private readonly reader: ClaudeCliCredentialReader,
    private readonly clock: () => number = Date.now,
  ) {}

  async discover(
    provider: SupportedModelProvider,
    _options: { allowKeychainPrompt: boolean },
  ): Promise<ExternalCliProfile[]> {
    if (provider !== "claude") return [];
    const credential = await this.reader.read();
    if (!credential || credential.expires <= this.clock()) return [];
    return [{ id: "claude-cli:default", provider: "claude", kind: "external_cli" }];
  }
}
