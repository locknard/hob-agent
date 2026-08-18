import type { AuthProfileStatus } from "./auth-profiles.js";
import type { PersistedProfileStatus } from "./auth-profile-state-store.js";

/** Stable actions that a UI or doctor command can offer without exposing credentials. */
export type AuthProfileDiagnosticAction = "none" | "reauthorize" | "fix_billing" | "wait";

/** Coarse health severity intended for stable presentation and automation. */
export type AuthProfileDiagnosticSeverity = "ok" | "warning" | "error";

/** The persisted, non-secret health fields used to disambiguate disabled states. */
export type AuthProfileDiagnosticHealth = Pick<
  PersistedProfileStatus,
  "cooldownUntil" | "cooldownReason" | "lastSuccessAt" | "failureCount" | "disabledReason"
>;

export interface AuthProfileDiagnosticInput {
  status: AuthProfileStatus;
  health?: Partial<AuthProfileDiagnosticHealth>;
}

/**
 * A secret-free profile health result. Keep this shape limited to stable
 * metadata: callers can safely serialize it for a status page or doctor.
 */
export interface AuthProfileDiagnostic {
  id: AuthProfileStatus["id"];
  provider: AuthProfileStatus["provider"];
  kind: AuthProfileStatus["kind"];
  availability: AuthProfileStatus["availability"];
  action: AuthProfileDiagnosticAction;
  severity: AuthProfileDiagnosticSeverity;
}

/** Maps runtime availability and persisted health to a safe user-facing diagnosis. */
export function diagnoseAuthProfile({ status, health }: AuthProfileDiagnosticInput): AuthProfileDiagnostic {
  const { action, severity } = diagnosisFor(status.availability, health?.disabledReason);
  return {
    id: status.id,
    provider: status.provider,
    kind: status.kind,
    availability: status.availability,
    action,
    severity,
  };
}

/** Diagnoses profiles in caller-provided order without reading or resolving secrets. */
export function diagnoseAuthProfiles(inputs: readonly AuthProfileDiagnosticInput[]): AuthProfileDiagnostic[] {
  return inputs.map(diagnoseAuthProfile);
}

function diagnosisFor(
  availability: AuthProfileStatus["availability"],
  disabledReason: AuthProfileDiagnosticHealth["disabledReason"] | undefined,
): Pick<AuthProfileDiagnostic, "action" | "severity"> {
  switch (availability) {
    case "ready":
      return { action: "none", severity: "ok" };
    case "cooldown":
      return { action: "wait", severity: "warning" };
    case "disabled":
      return disabledReason === "billing"
        ? { action: "fix_billing", severity: "error" }
        : { action: "reauthorize", severity: "error" };
    case "expired":
    case "needs_auth":
      return { action: "reauthorize", severity: "error" };
  }
}
