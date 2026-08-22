export interface OAuthCredential { type: "oauth"; access: string; refresh: string; expiresAt: number; }

/** Normalizes provider token responses with a five-minute refresh skew, as in OpenClaw. */
export function normalizeOAuthTokenResponse(
  response: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown },
  now = Date.now(),
): OAuthCredential {
  if (typeof response.access_token !== "string" || typeof response.refresh_token !== "string" || typeof response.expires_in !== "number" || response.expires_in <= 0) {
    throw new Error("OAuth token response is missing required fields");
  }
  return { type: "oauth", access: response.access_token, refresh: response.refresh_token, expiresAt: now + response.expires_in * 1000 - 300_000 };
}

/** Never overwrite a currently usable credential with an older refresh result. */
export function shouldReplaceOAuthCredential(existing: OAuthCredential | undefined, incoming: OAuthCredential, now = Date.now()): boolean {
  return !existing || existing.expiresAt <= now || incoming.expiresAt >= existing.expiresAt;
}
