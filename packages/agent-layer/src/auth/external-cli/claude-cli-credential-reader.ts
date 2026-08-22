import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCliOAuthCredential {
  access: string;
  refresh: string;
  expires: number;
}

export type ReadTextFile = (path: string) => Promise<string>;

/**
 * Reads the fixed Claude Code credential-file format. It deliberately has no
 * Keychain access: passive discovery must not trigger an OS credential prompt.
 */
export class FileClaudeCliCredentialReader {
  constructor(
    private readonly path = join(homedir(), ".claude", ".credentials.json"),
    private readonly readText: ReadTextFile = (file) => readFile(file, "utf8"),
  ) {}

  async read(): Promise<ClaudeCliOAuthCredential | undefined> {
    try {
      return parseClaudeCliOAuthCredential(JSON.parse(await this.readText(this.path)) as unknown);
    } catch {
      return undefined;
    }
  }
}

export function parseClaudeCliOAuthCredential(value: unknown): ClaudeCliOAuthCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const oauth = (value as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const data = oauth as Record<string, unknown>;
  if (
    typeof data.accessToken !== "string" || !data.accessToken ||
    typeof data.refreshToken !== "string" || !data.refreshToken ||
    typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt <= 0
  ) return undefined;
  return { access: data.accessToken, refresh: data.refreshToken, expires: data.expiresAt };
}
