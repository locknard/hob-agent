import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOAuthTokenResponse, shouldReplaceOAuthCredential } from "./oauth-credentials.js";

test("normalizes OAuth tokens with refresh safety margin", () => {
  assert.deepEqual(normalizeOAuthTokenResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }, 1_000), {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expiresAt: 3_301_000,
  });
});

test("keeps a newer usable OAuth credential when a stale refresh arrives", () => {
  assert.equal(shouldReplaceOAuthCredential(
    { type: "oauth", access: "fresh", refresh: "r", expiresAt: 20_000 },
    { type: "oauth", access: "stale", refresh: "r", expiresAt: 10_000 },
    1_000,
  ), false);
});
