import assert from "node:assert/strict";
import test from "node:test";

import { selectSafeOAuthBootstrap } from "./oauth-bootstrap.js";

const local = {
  type: "oauth" as const,
  provider: "claude",
  accountId: "household@example.test",
  access: "local-access",
  refresh: "local-refresh",
  expiresAt: 1_000,
};

test("keeps a usable local OAuth credential over an external CLI bootstrap", () => {
  assert.equal(selectSafeOAuthBootstrap(local, { ...local, access: "external", expiresAt: 9_000 }, 500), local);
});

test("uses an external OAuth bootstrap only when the expired local identity matches", () => {
  const external = { ...local, access: "external", refresh: "external-refresh", expiresAt: 9_000 };
  assert.equal(selectSafeOAuthBootstrap(local, external, 1_500), external);
});

test("rejects an external OAuth bootstrap with a mismatched or unprovable identity", () => {
  assert.equal(
    selectSafeOAuthBootstrap(local, { ...local, accountId: "other@example.test", expiresAt: 9_000 }, 1_500),
    undefined,
  );
  assert.equal(
    selectSafeOAuthBootstrap({ ...local, accountId: undefined }, { ...local, expiresAt: 9_000 }, 1_500),
    undefined,
  );
});
