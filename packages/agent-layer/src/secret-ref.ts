/**
 * The small SecretRef contract used by the Phase 0 agent layer.
 *
 * This module deliberately contains no secret-store implementation. In
 * particular, availability checks are safe to call from status/diagnostic
 * paths: they never invoke Keychain, enumerate environment variables, or
 * return a secret value.
 */

export type SecretRefSource = "env" | "keychain";

export type SecretRef =
  | { source: "env"; id: string }
  | { source: "keychain"; id: string };

export type SecretRefAvailability =
  | { status: "available"; ref: SecretRef }
  | { status: "missing"; ref: SecretRef }
  | { status: "blocked"; reason: "not-allowlisted" | "invalid-ref"; ref?: SecretRef }
  | { status: "unknown"; reason: "configured" | "canonical"; ref: SecretRef };

export interface ReadOnlySecretRefAvailabilityOptions {
  /** Environment snapshot supplied by the caller; this function never reads process.env. */
  env: Readonly<Record<string, string | undefined>>;
  /** Required explicit allowlist for env refs. No allowlist means no env ref is usable. */
  envAllowlist: Iterable<string>;
  /** Accepted for dependency-injection tests/documentation; it is intentionally never called. */
  readKeychain?: () => unknown;
}

const ENV_ID = /^[A-Z][A-Z0-9_]{0,127}$/;
const KEYCHAIN_ID = /^([^/\s:\r\n]+)\/([^/\s\r\n]+)$/;

/** Parse one of the exact Phase 0 canonical forms: env:NAME or keychain:service/account. */
export function parseSecretRef(value: unknown): SecretRef {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw invalidRef();
  }

  if (value.startsWith("env:")) {
    const id = value.slice("env:".length);
    if (!ENV_ID.test(id)) throw invalidRef();
    return { source: "env", id };
  }

  if (value.startsWith("keychain:")) {
    const id = value.slice("keychain:".length);
    const match = KEYCHAIN_ID.exec(id);
    if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
      throw invalidRef();
    }
    return { source: "keychain", id };
  }

  throw invalidRef();
}

/** Return true only for a structurally valid SecretRef object. */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2 || typeof candidate.id !== "string") return false;
  if (candidate.source === "env") return ENV_ID.test(candidate.id);
  if (candidate.source === "keychain") {
    const match = KEYCHAIN_ID.exec(candidate.id);
    return Boolean(match && match[1] !== "." && match[1] !== ".." && match[2] !== "." && match[2] !== "..");
  }
  return false;
}

/** Format a validated SecretRef into its stable canonical string form. */
export function formatSecretRef(value: unknown): string {
  if (!isSecretRef(value)) throw invalidRef();
  return `${value.source}:${value.id}`;
}

/** Stable non-secret key useful for comparing or indexing refs. */
export const secretRefKey = formatSecretRef;

/** Boolean convenience wrapper for grammar callers. */
export function isValidSecretRef(value: unknown): value is SecretRef {
  return isSecretRef(value);
}

/**
 * Check availability without resolving a SecretRef.
 *
 * Env values are consulted only for an explicitly allowlisted id. A valid
 * keychain ref is reported as unknown because passive status paths must not
 * call `security`, trigger an unlock prompt, or otherwise read Keychain.
 */
export function readOnlySecretRefAvailability(
  value: unknown,
  options: ReadOnlySecretRefAvailabilityOptions,
): SecretRefAvailability {
  const ref = toSecretRef(value);
  if (!ref) return { status: "blocked", reason: "invalid-ref" };

  if (ref.source === "keychain") {
    return { status: "unknown", reason: "configured", ref };
  }

  const allowlist = new Set(options.envAllowlist ?? []);
  if (!allowlist.has(ref.id)) {
    return { status: "blocked", reason: "not-allowlisted", ref };
  }
  return options.env[ref.id]?.trim().length
    ? { status: "available", ref }
    : { status: "missing", ref };
}

/** OpenClaw-shaped alias retained for callers that use the read-only name. */
export const resolveSecretRefReadOnlyAvailability = readOnlySecretRefAvailability;

function toSecretRef(value: unknown): SecretRef | undefined {
  if (isSecretRef(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    return parseSecretRef(value);
  } catch {
    return undefined;
  }
}

function invalidRef(): Error {
  // Do not interpolate the rejected input: it may itself contain a secret.
  return new Error("Invalid SecretRef");
}
