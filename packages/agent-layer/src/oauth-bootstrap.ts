import type { OAuthCredential } from "./oauth-credentials.js";

export interface IdentifiedOAuthCredential extends OAuthCredential {
  provider: string;
  accountId?: string;
}

/**
 * Decide whether an external OAuth source (for example a CLI) may bootstrap a
 * profile. A healthy local credential is authoritative; an expired profile
 * only accepts an external credential whose provider and explicit account
 * identity match. Missing identity fails closed.
 */
export function selectSafeOAuthBootstrap(
  local: IdentifiedOAuthCredential | undefined,
  external: IdentifiedOAuthCredential | undefined,
  now = Date.now(),
): IdentifiedOAuthCredential | undefined {
  if (local && local.expiresAt > now) return local;
  if (!external || external.expiresAt <= now) return undefined;
  if (!local) return external;
  if (
    local.provider !== external.provider ||
    !local.accountId ||
    !external.accountId ||
    local.accountId !== external.accountId
  ) return undefined;
  return external;
}
