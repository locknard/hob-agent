import type { FailureReason } from "./auth-profiles.js";

/** Normalize provider errors to stable, secret-free reasons for profile policy. */
export function classifyProviderFailure(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/429|rate.?limit|quota|too many requests/.test(message)) return "rate_limit";
  if (/401|403|invalid.*(key|token)|unauthori[sz]ed|forbidden/.test(message)) return "auth";
  if (/billing|payment|required|insufficient (balance|credit|funds)/.test(message)) return "billing";
  if (/timeout|timed out|etimedout/.test(message)) return "timeout";
  if (/overloaded|capacity|unavailable/.test(message)) return "overloaded";
  if (/invalid request|malformed|schema|unsupported/.test(message)) return "format";
  return "unknown";
}

/** API keys rotate only for transient capacity failures, never for auth/config faults. */
export function shouldTryNextProfile(reason: FailureReason): boolean {
  return reason === "rate_limit" || reason === "overloaded" || reason === "timeout";
}

/** Only credential-scoped failures may mutate shared profile health. */
export function shouldRecordProfileFailure(reason: FailureReason): boolean {
  return reason === "auth" || reason === "billing" || reason === "rate_limit";
}
