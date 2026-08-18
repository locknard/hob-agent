import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseAuthProfile, type AuthProfileDiagnosticInput } from "./auth-profile-diagnostics.js";

function input(
  availability: AuthProfileDiagnosticInput["status"]["availability"],
  health: AuthProfileDiagnosticInput["health"] = {},
): AuthProfileDiagnosticInput {
  return {
    status: {
      id: "gpt:primary",
      provider: "gpt",
      kind: "api_key",
      availability,
    },
    health,
  };
}

test("suggests reauthorization for a profile that needs auth", () => {
  assert.deepEqual(diagnoseAuthProfile(input("needs_auth")), {
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    availability: "needs_auth",
    action: "reauthorize",
    severity: "error",
  });
});

test("suggests reauthorization for an expired profile", () => {
  assert.equal(diagnoseAuthProfile(input("expired")).action, "reauthorize");
  assert.equal(diagnoseAuthProfile(input("expired")).severity, "error");
});

test("suggests reauthorization for an auth-disabled profile", () => {
  const diagnostic = diagnoseAuthProfile(input("disabled", { disabledReason: "auth" }));

  assert.equal(diagnostic.action, "reauthorize");
  assert.equal(diagnostic.severity, "error");
});

test("suggests fixing billing for a billing-disabled profile", () => {
  const diagnostic = diagnoseAuthProfile(input("disabled", { disabledReason: "billing" }));

  assert.equal(diagnostic.action, "fix_billing");
  assert.equal(diagnostic.severity, "error");
});

test("suggests waiting for a profile in cooldown", () => {
  const diagnostic = diagnoseAuthProfile(input("cooldown", {
    cooldownUntil: 2_000,
    cooldownReason: "rate_limit",
    lastSuccessAt: 1_000,
    failureCount: 2,
  }));

  assert.equal(diagnostic.action, "wait");
  assert.equal(diagnostic.severity, "warning");
});

test("reports a ready profile without a user action", () => {
  assert.deepEqual(diagnoseAuthProfile(input("ready")), {
    id: "gpt:primary",
    provider: "gpt",
    kind: "api_key",
    availability: "ready",
    action: "none",
    severity: "ok",
  });
});

test("returns only stable non-secret fields", () => {
  const diagnostic = diagnoseAuthProfile(input("ready", {
    disabledReason: undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    lastSuccessAt: 1_000,
    failureCount: 0,
  }));

  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "action",
    "availability",
    "id",
    "kind",
    "provider",
    "severity",
  ]);
  assert.equal("secretRef" in diagnostic, false);
  assert.equal("token" in diagnostic, false);
  assert.equal("rawError" in diagnostic, false);
});
