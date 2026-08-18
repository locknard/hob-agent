import { spawn } from "node:child_process";

import type { SecretVault } from "./pi-credential-store.js";
import { parseSecretRef } from "./secret-ref.js";

export interface WritableSecretVault extends SecretVault {
  write(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export interface KeychainCommandResult {
  ok: boolean;
  stdout: string;
}

export type KeychainCommand = (
  args: readonly string[],
  options?: { input?: string },
) => Promise<KeychainCommandResult>;

/**
 * macOS Keychain-backed secret vault. It accepts only a fully scoped
 * `keychain:service/account` reference and never lists, logs, or persists
 * keychain values outside the operating system credential store.
 */
export class MacOSKeychainSecretVault implements WritableSecretVault {
  constructor(private readonly command: KeychainCommand = runMacOSSecurityCommand) {}

  async read(reference: string): Promise<string | undefined> {
    const { service, account } = parseReference(reference);
    const result = await this.command([
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    return result.ok ? stripTrailingNewline(result.stdout) : undefined;
  }

  async write(reference: string, value: string): Promise<void> {
    const { service, account } = parseReference(reference);
    const result = await this.command([
      "add-generic-password", "-U", "-s", service, "-a", account, "-w",
    ], { input: value });
    if (!result.ok) throw new Error("Unable to write Keychain secret");
  }

  async delete(reference: string): Promise<void> {
    const { service, account } = parseReference(reference);
    const result = await this.command(["delete-generic-password", "-s", service, "-a", account]);
    if (!result.ok) throw new Error("Unable to delete Keychain secret");
  }
}

export async function runMacOSSecurityCommand(
  args: readonly string[],
  options?: { input?: string },
): Promise<KeychainCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("security", [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => resolve({ ok: false, stdout: "" }));
    child.once("close", (code) => resolve({ ok: code === 0, stdout: code === 0 ? stdout : "" }));
    child.stdin.end(options?.input === undefined ? undefined : `${options.input}\n`);
  });
}

function parseReference(reference: string): { service: string; account: string } {
  try {
    const ref = parseSecretRef(reference);
    if (ref.source !== "keychain") throw new Error();
    const separator = ref.id.indexOf("/");
    return { service: ref.id.slice(0, separator), account: ref.id.slice(separator + 1) };
  } catch {
    throw new Error("Invalid keychain secret reference");
  }
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}
