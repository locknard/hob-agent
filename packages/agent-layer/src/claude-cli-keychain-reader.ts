import { parseClaudeCliOAuthCredential, type ClaudeCliOAuthCredential } from "./claude-cli-credential-reader.js";
import { runMacOSSecurityCommand, type KeychainCommand } from "./macos-keychain-secret-vault.js";

const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Keychain reader used only after a user explicitly opts to import their
 * Claude Code login. Passive discovery uses the file-only reader instead.
 */
export class MacOSClaudeCliKeychainReader {
  constructor(
    private readonly command: KeychainCommand = runMacOSSecurityCommand,
    private readonly allowKeychainPrompt = false,
  ) {}

  async read(): Promise<ClaudeCliOAuthCredential | undefined> {
    if (!this.allowKeychainPrompt) return undefined;
    const result = await this.command([
      "find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-w",
    ]);
    if (!result.ok) return undefined;
    try {
      return parseClaudeCliOAuthCredential(JSON.parse(result.stdout) as unknown);
    } catch {
      return undefined;
    }
  }
}
