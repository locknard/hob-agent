import { createHash, randomBytes } from "node:crypto";

export interface OAuthConfiguration { authorizationEndpoint: string; clientId: string; redirectUri: string; scopes: string[]; }
export interface OAuthAuthorization extends OAuthConfiguration { state: string; verifier: string; url: string; }

/** Generic OAuth authorization-code + PKCE request, adapted from OpenClaw's provider-auth runtime. */
export function createOAuthAuthorization(config: OAuthConfiguration, random: () => string = () => randomBytes(48).toString("base64url")): OAuthAuthorization {
  const state = random();
  const verifier = random();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { ...config, state, verifier, url: url.toString() };
}

/** Callback state must match exactly and is consumed by the caller after exchange. */
export function validateOAuthCallback(request: OAuthAuthorization, callback: { code?: string; state?: string; error?: string }): string {
  if (callback.error) throw new Error(`OAuth authorization failed: ${callback.error}`);
  if (!callback.code || callback.state !== request.state) throw new Error("OAuth state validation failed");
  return callback.code;
}
