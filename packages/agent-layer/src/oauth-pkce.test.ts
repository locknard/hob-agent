import assert from "node:assert/strict";
import test from "node:test";

import { createOAuthAuthorization, validateOAuthCallback } from "./oauth-pkce.js";

test("creates PKCE authorization state and rejects a mismatched callback", () => {
  const request = createOAuthAuthorization({
    authorizationEndpoint: "https://provider.example/authorize",
    clientId: "client",
    redirectUri: "http://127.0.0.1:9876/callback",
    scopes: ["profile", "offline_access"],
  }, () => "a".repeat(64));
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "a".repeat(64));
  assert.throws(() => validateOAuthCallback(request, { code: "code", state: "wrong" }), /state validation failed/);
  assert.equal(validateOAuthCallback(request, { code: "code", state: request.state }), "code");
});
